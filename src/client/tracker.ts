/**
 * OneClick CAPI Connector — Lightweight Client Tracker
 * ----------------------------------------------------
 * Drop-in browser tracker for the EC "Thank You" / order-confirmation page.
 *
 * Embed (after building to plain JS) with a single line:
 *   <script
 *     src="https://your-relay.example.com/tracker.js"
 *     data-endpoint="https://your-relay.example.com/api/events"
 *     data-email="customer@example.com"
 *     data-phone="+81 90-1234-5678"
 *     data-value="12800"
 *     data-currency="JPY"
 *     data-event-id="order_1001"
 *     defer></script>
 *
 * Or call it programmatically:
 *   OneClickCAPI.trackPurchase({
 *     email: "customer@example.com",
 *     phone: "+81 90-1234-5678",
 *     value: 12800,
 *     currency: "JPY",
 *     eventId: "order_1001",
 *   });
 *
 * IMPORTANT — Zero-Knowledge Architecture:
 *   This client sends RAW email/phone over TLS to *your own* relay server only.
 *   The relay normalizes + SHA-256 hashes the values in-memory and forwards
 *   ONLY the hashes to Meta / Google. No PII is ever persisted or logged.
 *   Never point `data-endpoint` at a third party you do not control.
 */

/**
 * Shape of a purchase event captured on the front-end.
 * Raw (un-hashed) PII — transmitted to the first-party relay over HTTPS only.
 */
export interface PurchaseEventInput {
  /** Raw customer email (will be normalized + hashed server-side). Optional but strongly recommended for match quality. */
  email?: string | null;
  /** Raw customer phone in any format (will be normalized + hashed server-side). Optional. */
  phone?: string | null;
  /** Order monetary value. Numbers or numeric strings (e.g. "12,800") are accepted. */
  value: number | string;
  /** ISO-4217 currency code, e.g. "JPY", "USD". */
  currency: string;
  /**
   * Deduplication key shared with the browser-side Pixel/gtag event.
   * Meta uses this to de-duplicate the browser event and the CAPI event.
   * Strongly recommended: use the order ID.
   */
  eventId: string;
  /** Optional override for the canonical event name. Defaults to "Purchase". */
  eventName?: string;
  /** Optional first name (normalized + hashed server-side). */
  firstName?: string | null;
  /** Optional last name (normalized + hashed server-side). */
  lastName?: string | null;
  /** Optional city (normalized + hashed server-side). */
  city?: string | null;
  /** Optional 2-letter country code (normalized + hashed server-side). */
  country?: string | null;
}

/**
 * The exact payload sent to the relay. Adds browser-only context that the
 * server cannot otherwise reconstruct (URL, user agent, Meta cookies).
 */
export interface TrackerPayload {
  event_name: string;
  event_id: string;
  /** Unix timestamp in SECONDS — Meta/Google both expect seconds, not millis. */
  event_time: number;
  event_source_url: string;
  action_source: "website";
  value: number;
  currency: string;
  user_data: {
    email?: string | null;
    phone?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    city?: string | null;
    country?: string | null;
    /** Meta browser ID cookie (_fbp). Forwarded as-is; not PII. */
    fbp?: string | null;
    /** Meta click ID cookie (_fbc) or fbclid-derived value. Forwarded as-is; not PII. */
    fbc?: string | null;
    /** Best-effort client user agent for match quality. */
    client_user_agent?: string | null;
  };
}

/** Tunable runtime options for the tracker. */
export interface TrackerOptions {
  /** Absolute URL of your first-party relay endpoint, e.g. "https://relay.example.com/api/events". */
  endpoint: string;
  /** When true, logs diagnostic info to the console. Default: false. */
  debug?: boolean;
  /** Network timeout in milliseconds for the relay request. Default: 4000. */
  timeoutMs?: number;
}

/**
 * Reads a browser cookie by name. Returns null when not present.
 * Used to forward Meta's _fbp / _fbc identifiers for higher Event Match Quality.
 */
function readCookie(name: string): string | null {
  if (typeof document === "undefined" || !document.cookie) {
    return null;
  }
  const prefix = `${name}=`;
  const segments = document.cookie.split(";");
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.indexOf(prefix) === 0) {
      return decodeURIComponent(trimmed.substring(prefix.length));
    }
  }
  return null;
}

/**
 * Derives the Meta `_fbc` click-id value.
 * Prefers the `_fbc` cookie; otherwise synthesizes it from a `fbclid` URL param,
 * following Meta's documented format: `fb.1.<timestampMs>.<fbclid>`.
 */
function resolveFbc(): string | null {
  const cookieFbc = readCookie("_fbc");
  if (cookieFbc) {
    return cookieFbc;
  }
  if (typeof window === "undefined" || !window.location || !window.location.search) {
    return null;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const fbclid = params.get("fbclid");
    if (fbclid) {
      return `fb.1.${Date.now()}.${fbclid}`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Coerces a value that may be a formatted string ("12,800", "¥12,800", "12800.50")
 * into a finite Number. Throws when it cannot be parsed to avoid sending garbage.
 */
function coerceAmount(raw: number | string): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new Error(`Invalid numeric value: ${raw}`);
    }
    return raw;
  }
  // Strip every character that is not a digit, a dot, or a minus sign.
  const cleaned = String(raw).replace(/[^0-9.\-]/g, "");
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to parse value from "${raw}"`);
  }
  return parsed;
}

/** Trims a string and returns null for empty/whitespace-only inputs. */
function nullableTrim(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Builds the full payload from raw input plus browser context.
 * No hashing happens here — hashing is exclusively a server responsibility.
 */
function buildPayload(input: PurchaseEventInput): TrackerPayload {
  const eventId = nullableTrim(input.eventId);
  if (!eventId) {
    throw new Error("eventId is required for deduplication and cannot be empty.");
  }

  const currency = nullableTrim(input.currency);
  if (!currency) {
    throw new Error("currency is required (ISO-4217, e.g. 'JPY').");
  }

  return {
    event_name: nullableTrim(input.eventName) ?? "Purchase",
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event_source_url:
      typeof window !== "undefined" && window.location ? window.location.href : "",
    action_source: "website",
    value: coerceAmount(input.value),
    currency: currency.toUpperCase(),
    user_data: {
      email: nullableTrim(input.email),
      phone: nullableTrim(input.phone),
      first_name: nullableTrim(input.firstName),
      last_name: nullableTrim(input.lastName),
      city: nullableTrim(input.city),
      country: nullableTrim(input.country),
      fbp: readCookie("_fbp"),
      fbc: resolveFbc(),
      client_user_agent:
        typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : null,
    },
  };
}

/**
 * Sends the payload to the relay.
 * Uses `navigator.sendBeacon` when available (survives page unload on the
 * Thank-You page), and falls back to `fetch` with `keepalive` + a timeout.
 */
async function dispatch(
  payload: TrackerPayload,
  options: TrackerOptions
): Promise<boolean> {
  const endpoint = options.endpoint;
  const debug = options.debug === true;
  const body = JSON.stringify(payload);

  // Preferred path: sendBeacon is fire-and-forget and unload-safe.
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.sendBeacon === "function"
  ) {
    try {
      const blob = new Blob([body], { type: "application/json" });
      const queued = navigator.sendBeacon(endpoint, blob);
      if (debug) {
        // eslint-disable-next-line no-console
        console.info("[OneClickCAPI] sendBeacon queued:", queued, payload);
      }
      if (queued) {
        return true;
      }
      // If the browser refused to queue, fall through to fetch.
    } catch (error) {
      if (debug) {
        // eslint-disable-next-line no-console
        console.warn("[OneClickCAPI] sendBeacon failed, falling back to fetch:", error);
      }
    }
  }

  // Fallback path: fetch with keepalive and an explicit timeout.
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 4000;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer =
    controller !== null
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "omit",
      mode: "cors",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (debug) {
      // eslint-disable-next-line no-console
      console.info("[OneClickCAPI] fetch status:", response.status, payload);
    }
    return response.ok;
  } catch (error) {
    if (debug) {
      // eslint-disable-next-line no-console
      console.error("[OneClickCAPI] fetch failed:", error);
    }
    return false;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/**
 * Resolves the relay endpoint from (in priority order):
 *   1. an explicit argument,
 *   2. the embedding <script data-endpoint="...">,
 *   3. a global window.ONECLICK_CAPI_ENDPOINT.
 */
function resolveEndpoint(explicit?: string): string | null {
  const fromArg = nullableTrim(explicit);
  if (fromArg) {
    return fromArg;
  }

  if (typeof document !== "undefined") {
    const current = document.currentScript as HTMLScriptElement | null;
    const fromCurrent = current ? nullableTrim(current.getAttribute("data-endpoint")) : null;
    if (fromCurrent) {
      return fromCurrent;
    }
    // currentScript is null for deferred/async scripts; scan as a fallback.
    const scripts = document.querySelectorAll<HTMLScriptElement>("script[data-endpoint]");
    for (let i = 0; i < scripts.length; i += 1) {
      const candidate = nullableTrim(scripts[i]!.getAttribute("data-endpoint"));
      if (candidate) {
        return candidate;
      }
    }
  }

  const globalEndpoint =
    typeof window !== "undefined"
      ? nullableTrim((window as unknown as { ONECLICK_CAPI_ENDPOINT?: string }).ONECLICK_CAPI_ENDPOINT)
      : null;
  return globalEndpoint;
}

/**
 * Public API: track a purchase event.
 * Resolves to `true` when the relay accepted (or beacon-queued) the event.
 */
export async function trackPurchase(
  input: PurchaseEventInput,
  options?: Partial<TrackerOptions>
): Promise<boolean> {
  const endpoint = resolveEndpoint(options ? options.endpoint : undefined);
  if (!endpoint) {
    // eslint-disable-next-line no-console
    console.error(
      "[OneClickCAPI] No relay endpoint configured. Set data-endpoint on the <script> tag, " +
        "window.ONECLICK_CAPI_ENDPOINT, or pass { endpoint } explicitly."
    );
    return false;
  }

  let payload: TrackerPayload;
  try {
    payload = buildPayload(input);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[OneClickCAPI] Invalid purchase input:", error);
    return false;
  }

  return dispatch(payload, {
    endpoint,
    debug: options ? options.debug === true : false,
    ...(options && typeof options.timeoutMs === "number"
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
}

/**
 * Reads a purchase event from the embedding <script data-*> attributes.
 * Returns null when no usable data attributes are present.
 */
function readFromScriptDataset(): PurchaseEventInput | null {
  if (typeof document === "undefined") {
    return null;
  }

  const current = document.currentScript as HTMLScriptElement | null;
  const scriptEl =
    current && current.hasAttribute("data-value")
      ? current
      : document.querySelector<HTMLScriptElement>("script[data-value]");

  if (!scriptEl) {
    return null;
  }

  const value = scriptEl.getAttribute("data-value");
  const currency = scriptEl.getAttribute("data-currency");
  const eventId = scriptEl.getAttribute("data-event-id");

  if (!value || !currency || !eventId) {
    return null;
  }

  const eventName = scriptEl.getAttribute("data-event-name");

  return {
    email: scriptEl.getAttribute("data-email"),
    phone: scriptEl.getAttribute("data-phone"),
    firstName: scriptEl.getAttribute("data-first-name"),
    lastName: scriptEl.getAttribute("data-last-name"),
    city: scriptEl.getAttribute("data-city"),
    country: scriptEl.getAttribute("data-country"),
    value,
    currency,
    eventId,
    ...(eventName ? { eventName } : {}),
  };
}

/** Global surface exposed on `window.OneClickCAPI`. */
export interface OneClickCAPIGlobal {
  trackPurchase: typeof trackPurchase;
  version: string;
}

const VERSION = "1.0.0";

// Auto-initialization: when embedded as a plain <script> with data-* attributes,
// fire the purchase event automatically once the DOM is ready.
(function autoInit(): void {
  if (typeof window === "undefined") {
    return;
  }

  const globalApi: OneClickCAPIGlobal = {
    trackPurchase,
    version: VERSION,
  };
  (window as unknown as { OneClickCAPI: OneClickCAPIGlobal }).OneClickCAPI = globalApi;

  const run = (): void => {
    const datasetInput = readFromScriptDataset();
    if (datasetInput) {
      const debugAttr =
        typeof document !== "undefined"
          ? document.querySelector<HTMLScriptElement>("script[data-endpoint]")?.getAttribute("data-debug")
          : null;
      void trackPurchase(datasetInput, { debug: debugAttr === "true" });
    }
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
  }
})();
