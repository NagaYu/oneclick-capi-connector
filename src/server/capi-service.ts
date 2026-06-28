/**
 * OneClick CAPI Connector — Conversion Dispatch Service
 * -----------------------------------------------------
 * Maps hashed user data + event metadata onto the exact payload shapes that
 * Meta (Conversions API) and Google (Enhanced Conversions via Google Ads API)
 * expect, then POSTs them with axios.
 *
 * Design notes:
 *   - Inputs are ALREADY hashed by normalizer.ts. This module never sees or
 *     logs raw PII. Even on error it logs only hash prefixes and HTTP metadata.
 *   - Each platform call is fully isolated in its own try/catch so a failure on
 *     one network does not prevent delivery on the other.
 *   - Errors are normalized into a structured result so the HTTP layer can
 *     decide on ret/queue behaviour without parsing axios internals.
 */

import axios, { AxiosError, type AxiosInstance } from "axios";
import type { HashedUserData } from "./normalizer";

/** Shared event fields (already validated by the HTTP layer). */
export interface ConversionEvent {
  /** Canonical event name, e.g. "Purchase". */
  eventName: string;
  /** Deduplication ID shared with the browser Pixel/gtag event. */
  eventId: string;
  /** Unix time in SECONDS. */
  eventTime: number;
  /** Page URL where the conversion occurred. */
  eventSourceUrl: string;
  /** Monetary value of the conversion. */
  value: number;
  /** ISO-4217 currency code, uppercased. */
  currency: string;
  /** Hashed user identifiers. */
  user: HashedUserData;
  /** Non-PII Meta browser cookies, forwarded as-is. */
  fbp?: string | null | undefined;
  fbc?: string | null | undefined;
  /** Best-effort client user agent (improves Meta match quality). */
  clientUserAgent?: string | null | undefined;
  /** Best-effort client IP (improves Meta match quality). */
  clientIpAddress?: string | null | undefined;
}

/** Meta Conversions API configuration. */
export interface MetaConfig {
  enabled: boolean;
  pixelId: string;
  accessToken: string;
  /** Optional Test Event Code from Events Manager → Test Events. */
  testEventCode?: string | undefined;
  /** Graph API version, e.g. "v21.0". */
  apiVersion: string;
}

/** Google Enhanced Conversions (Google Ads API) configuration. */
export interface GoogleConfig {
  enabled: boolean;
  /** OAuth2 access token (Bearer). */
  accessToken: string;
  /** Google Ads developer token. */
  developerToken: string;
  /** Target customer ID, digits only, no dashes. */
  customerId: string;
  /** Login (manager/MCC) customer ID, digits only. Optional. */
  loginCustomerId?: string | undefined;
  /** Conversion action resource name, e.g. "customers/123/conversionActions/456". */
  conversionActionResourceName: string;
  /** Google Ads API version, e.g. "v17". */
  apiVersion: string;
}

/** Full dispatcher configuration. */
export interface CapiServiceConfig {
  meta: MetaConfig;
  google: GoogleConfig;
  /** Per-request timeout in milliseconds. Default 8000. */
  requestTimeoutMs?: number;
  /**
   * When true, the relay performs the full normalize→hash→validate pipeline but
   * does NOT send to Meta/Google. Lets you deploy and verify end-to-end without
   * any ad-platform credentials. Flip to false (and supply tokens) to go live.
   */
  dryRun?: boolean;
}

/** Outcome of a single platform dispatch. */
export interface DispatchResult {
  platform: "meta" | "google";
  ok: boolean;
  skipped: boolean;
  /** HTTP status when a response was received. */
  status?: number;
  /** Short, PII-free human-readable message. */
  message: string;
  /** Platform-specific identifiers/diagnostics, PII-free. */
  details?: Record<string, unknown>;
}

/** Combined result for one event across all platforms. */
export interface DispatchSummary {
  eventId: string;
  results: DispatchResult[];
}

/**
 * Returns a short, log-safe fingerprint of a hash (first 8 hex chars) or a
 * placeholder. NEVER returns the full hash — keeps logs non-correlatable.
 */
function hashFingerprint(hash: string | null | undefined): string {
  if (!hash) {
    return "∅";
  }
  return `${hash.slice(0, 8)}…`;
}

/**
 * Extracts a PII-free, structured error descriptor from any thrown value.
 * Pulls HTTP status + the platform's own error body when present.
 */
function describeError(error: unknown): {
  status?: number;
  message: string;
  body?: unknown;
} {
  if (axios.isAxiosError(error)) {
    const axErr = error as AxiosError;
    const status = axErr.response?.status;
    const body = axErr.response?.data;
    // Prefer the platform's structured error message, but never echo PII.
    let message = axErr.message;
    if (body && typeof body === "object") {
      const maybeError = (body as { error?: { message?: string } }).error;
      if (maybeError && typeof maybeError.message === "string") {
        message = maybeError.message;
      }
    }
    return status !== undefined
      ? { status, message, body }
      : { message, body };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

/**
 * The dispatch service. Construct once at boot with validated config and reuse.
 */
export class CapiService {
  private readonly config: CapiServiceConfig;
  private readonly http: AxiosInstance;

  public constructor(config: CapiServiceConfig) {
    this.config = config;
    this.http = axios.create({
      timeout: config.requestTimeoutMs ?? 8000,
      // We handle non-2xx ourselves via try/catch; let axios throw on >=400.
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Dispatches a single conversion event to every enabled platform.
   * Runs platforms concurrently; one platform failing never blocks the other.
   */
  public async dispatch(event: ConversionEvent): Promise<DispatchSummary> {
    const results = await Promise.all([
      this.dispatchToPlatform("meta", event),
      this.dispatchToPlatform("google", event),
    ]);
    return { eventId: event.eventId, results };
  }

  /**
   * Produces a DRY-RUN result: the event was normalized, hashed, and validated,
   * but intentionally NOT sent upstream. Logs only hash fingerprints (no PII).
   */
  private dryRunResult(
    platform: "meta" | "google",
    event: ConversionEvent
  ): DispatchResult {
    const phoneHash =
      platform === "meta" ? event.user.phone_meta : event.user.phone_google;
    // eslint-disable-next-line no-console
    console.info(
      `[CAPI:${platform}] DRY-RUN event_id=${event.eventId} (not sent) ` +
        `em=${hashFingerprint(event.user.email)} ph=${hashFingerprint(phoneHash)}`
    );
    return {
      platform,
      ok: true,
      skipped: false,
      message: `DRY-RUN: hashed & validated, not dispatched to ${platform}.`,
      details: {
        dry_run: true,
        email_hash: hashFingerprint(event.user.email),
        phone_hash: hashFingerprint(phoneHash),
      },
    };
  }

  /**
   * Dispatches to a single platform on demand. Used by the retry queue to
   * re-attempt only the destination that previously failed (the other may have
   * already succeeded, so we must not double-send to it).
   *
   * Returns the {@link DispatchResult}; the caller decides whether `ok === false`
   * warrants another retry. Honors the per-platform `enabled` flag.
   */
  public async dispatchToPlatform(
    platform: "meta" | "google",
    event: ConversionEvent
  ): Promise<DispatchResult> {
    if (platform === "meta") {
      if (!this.config.meta.enabled) {
        return {
          platform: "meta",
          ok: false,
          skipped: true,
          message: "Meta dispatch disabled by configuration.",
        };
      }
      if (this.config.dryRun) {
        return this.dryRunResult("meta", event);
      }
      return this.sendToMeta(event);
    }
    if (!this.config.google.enabled) {
      return {
        platform: "google",
        ok: false,
        skipped: true,
        message: "Google dispatch disabled by configuration.",
      };
    }
    if (this.config.dryRun) {
      return this.dryRunResult("google", event);
    }
    return this.sendToGoogle(event);
  }

  /**
   * Sends the event to Meta's Conversions API.
   * Docs: https://developers.facebook.com/docs/marketing-api/conversions-api
   */
  private async sendToMeta(event: ConversionEvent): Promise<DispatchResult> {
    const meta = this.config.meta;
    const url = `https://graph.facebook.com/${meta.apiVersion}/${meta.pixelId}/events`;

    // Build user_data with only the fields that are present, using the
    // Meta-correct key names and hash forms.
    const userData: Record<string, unknown> = {};
    if (event.user.email) {
      userData["em"] = [event.user.email];
    }
    if (event.user.phone_meta) {
      userData["ph"] = [event.user.phone_meta];
    }
    if (event.user.first_name) {
      userData["fn"] = [event.user.first_name];
    }
    if (event.user.last_name) {
      userData["ln"] = [event.user.last_name];
    }
    if (event.user.city) {
      userData["ct"] = [event.user.city];
    }
    if (event.user.country) {
      userData["country"] = [event.user.country];
    }
    // Non-PII identifiers are sent un-hashed per Meta's spec.
    if (event.fbp) {
      userData["fbp"] = event.fbp;
    }
    if (event.fbc) {
      userData["fbc"] = event.fbc;
    }
    if (event.clientUserAgent) {
      userData["client_user_agent"] = event.clientUserAgent;
    }
    if (event.clientIpAddress) {
      userData["client_ip_address"] = event.clientIpAddress;
    }

    const payload: Record<string, unknown> = {
      data: [
        {
          event_name: event.eventName,
          event_time: event.eventTime,
          event_id: event.eventId,
          event_source_url: event.eventSourceUrl,
          action_source: "website",
          user_data: userData,
          custom_data: {
            value: event.value,
            currency: event.currency,
          },
        },
      ],
    };

    if (meta.testEventCode && meta.testEventCode.length > 0) {
      payload["test_event_code"] = meta.testEventCode;
    }

    try {
      const response = await this.http.post(url, payload, {
        params: { access_token: meta.accessToken },
      });

      const data = response.data as {
        events_received?: number;
        fbtrace_id?: string;
        messages?: unknown[];
      };

      // eslint-disable-next-line no-console
      console.info(
        `[CAPI:meta] OK event_id=${event.eventId} status=${response.status} ` +
          `events_received=${data.events_received ?? "?"} em=${hashFingerprint(
            event.user.email
          )} ph=${hashFingerprint(event.user.phone_meta)} fbtrace=${
            data.fbtrace_id ?? "?"
          }`
      );

      return {
        platform: "meta",
        ok: true,
        skipped: false,
        status: response.status,
        message: "Accepted by Meta Conversions API.",
        details: {
          events_received: data.events_received ?? null,
          fbtrace_id: data.fbtrace_id ?? null,
        },
      };
    } catch (error) {
      const described = describeError(error);
      // eslint-disable-next-line no-console
      console.error(
        `[CAPI:meta] FAIL event_id=${event.eventId} status=${
          described.status ?? "n/a"
        } message="${described.message}" em=${hashFingerprint(
          event.user.email
        )} ph=${hashFingerprint(event.user.phone_meta)}`
      );

      return {
        platform: "meta",
        ok: false,
        skipped: false,
        ...(described.status !== undefined ? { status: described.status } : {}),
        message: `Meta Conversions API error: ${described.message}`,
        details: { error: described.body ?? null },
      };
    }
  }

  /**
   * Sends the event to Google Ads Enhanced Conversions via uploadClickConversions.
   * Docs: https://developers.google.com/google-ads/api/docs/conversions/upload-clicks
   *        https://developers.google.com/google-ads/api/docs/conversions/enhanced-conversions/web
   */
  private async sendToGoogle(event: ConversionEvent): Promise<DispatchResult> {
    const google = this.config.google;
    const customerId = google.customerId.replace(/\D/g, "");
    const url =
      `https://googleads.googleapis.com/${google.apiVersion}/customers/` +
      `${customerId}:uploadClickConversions`;

    // Build hashed userIdentifiers using Google's key names + hash forms.
    const userIdentifiers: Array<Record<string, unknown>> = [];
    if (event.user.email) {
      userIdentifiers.push({ hashedEmail: event.user.email });
    }
    if (event.user.phone_google) {
      userIdentifiers.push({ hashedPhoneNumber: event.user.phone_google });
    }
    // Address-based identifier (all sub-fields hashed where applicable).
    const addressInfo: Record<string, unknown> = {};
    if (event.user.first_name) {
      addressInfo["hashedFirstName"] = event.user.first_name;
    }
    if (event.user.last_name) {
      addressInfo["hashedLastName"] = event.user.last_name;
    }
    if (event.user.country) {
      // Google expects the un-hashed 2-letter country code in addressInfo.
      // We only have the hash here; omit to avoid sending a mismatched value.
      // (Country alone is low-signal; email/phone drive the match.)
    }
    if (Object.keys(addressInfo).length > 0) {
      userIdentifiers.push({ addressInfo });
    }

    // Google expects RFC-3339 / "yyyy-mm-dd hh:mm:ss+|-hh:mm" conversion time.
    const conversionDateTime = formatGoogleDateTime(event.eventTime);

    const payload: Record<string, unknown> = {
      conversions: [
        {
          conversionAction: google.conversionActionResourceName,
          conversionDateTime,
          conversionValue: event.value,
          currencyCode: event.currency,
          orderId: event.eventId,
          userIdentifiers,
        },
      ],
      partialFailure: true,
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${google.accessToken}`,
      "developer-token": google.developerToken,
    };
    if (google.loginCustomerId && google.loginCustomerId.length > 0) {
      headers["login-customer-id"] = google.loginCustomerId.replace(/\D/g, "");
    }

    try {
      const response = await this.http.post(url, payload, { headers });

      const data = response.data as {
        partialFailureError?: { message?: string };
        results?: unknown[];
      };

      // A 200 with partialFailureError means the row was rejected — treat as fail.
      if (data.partialFailureError && data.partialFailureError.message) {
        // eslint-disable-next-line no-console
        console.error(
          `[CAPI:google] PARTIAL_FAILURE event_id=${event.eventId} ` +
            `message="${data.partialFailureError.message}" em=${hashFingerprint(
              event.user.email
            )} ph=${hashFingerprint(event.user.phone_google)}`
        );
        return {
          platform: "google",
          ok: false,
          skipped: false,
          status: response.status,
          message: `Google partial failure: ${data.partialFailureError.message}`,
          details: { partialFailureError: data.partialFailureError },
        };
      }

      // eslint-disable-next-line no-console
      console.info(
        `[CAPI:google] OK event_id=${event.eventId} status=${response.status} ` +
          `results=${Array.isArray(data.results) ? data.results.length : 0} ` +
          `em=${hashFingerprint(event.user.email)} ph=${hashFingerprint(
            event.user.phone_google
          )}`
      );

      return {
        platform: "google",
        ok: true,
        skipped: false,
        status: response.status,
        message: "Accepted by Google Ads Enhanced Conversions.",
        details: {
          results: Array.isArray(data.results) ? data.results.length : 0,
        },
      };
    } catch (error) {
      const described = describeError(error);
      // eslint-disable-next-line no-console
      console.error(
        `[CAPI:google] FAIL event_id=${event.eventId} status=${
          described.status ?? "n/a"
        } message="${described.message}" em=${hashFingerprint(
          event.user.email
        )} ph=${hashFingerprint(event.user.phone_google)}`
      );

      return {
        platform: "google",
        ok: false,
        skipped: false,
        ...(described.status !== undefined ? { status: described.status } : {}),
        message: `Google Ads API error: ${described.message}`,
        details: { error: described.body ?? null },
      };
    }
  }
}

/**
 * Formats a Unix-seconds timestamp into the "yyyy-mm-dd hh:mm:ss+00:00" form
 * Google Ads requires for `conversionDateTime`. Emitted in UTC for determinism.
 */
export function formatGoogleDateTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}+00:00`;
}
