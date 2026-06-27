/**
 * OneClick CAPI Connector — Express Relay Server
 * ----------------------------------------------
 * Receives raw conversion events from the first-party client tracker, hashes
 * all PII in-memory (zero-knowledge), and forwards ONLY the hashes to Meta CAPI
 * and Google Enhanced Conversions.
 *
 * Endpoints:
 *   GET  /healthz       — liveness/readiness probe (no PII).
 *   POST /api/events    — accept one conversion event and relay it.
 *
 * Security posture:
 *   - No request body containing raw PII is ever logged.
 *   - CORS is locked to an explicit allow-list (ALLOWED_ORIGINS).
 *   - Optional shared-secret header (RELAY_SHARED_SECRET) gates writes.
 */

import path from "node:path";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors, { type CorsOptions } from "cors";
import dotenv from "dotenv";

import { hashUserData, DEFAULT_PHONE_COUNTRY_CODE } from "./normalizer";
import {
  CapiService,
  type CapiServiceConfig,
  type ConversionEvent,
} from "./capi-service";
import { RetryQueue, type RetryQueueOptions } from "./retry-queue";

dotenv.config();

/* -------------------------------------------------------------------------- */
/* Configuration loading & validation                                          */
/* -------------------------------------------------------------------------- */

/** Reads a required env var; throws at boot when missing so misconfig fails fast. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/** Reads an optional env var, returning a fallback when absent. */
function optionalEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

/** Parses a boolean-ish env var ("true"/"1"/"yes" → true). */
function boolEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name);
  if (value.length === 0) {
    return fallback;
  }
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

/** Loaded, validated runtime configuration. */
export interface AppConfig {
  port: number;
  allowedOrigins: string[];
  sharedSecret: string;
  phoneCountryCode: string;
  capi: CapiServiceConfig;
  retry: RetryQueueOptions;
}

/** Parses an integer env var with a fallback. */
function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(optionalEnv(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Builds the full app config from process.env, enabling each platform only when
 * its mandatory credentials are present. Fails fast if NEITHER is configured.
 */
function loadConfig(): AppConfig {
  const port = Number.parseInt(optionalEnv("PORT", "8080"), 10);

  const allowedOrigins = optionalEnv("ALLOWED_ORIGINS")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const metaEnabled = boolEnv("META_ENABLED", true);
  const googleEnabled = boolEnv("GOOGLE_ENABLED", false);

  const meta = metaEnabled
    ? {
        enabled: true,
        pixelId: requireEnv("META_PIXEL_ID"),
        accessToken: requireEnv("META_ACCESS_TOKEN"),
        testEventCode: optionalEnv("META_TEST_EVENT_CODE") || undefined,
        apiVersion: optionalEnv("META_API_VERSION", "v21.0"),
      }
    : {
        enabled: false,
        pixelId: "",
        accessToken: "",
        testEventCode: undefined,
        apiVersion: optionalEnv("META_API_VERSION", "v21.0"),
      };

  const google = googleEnabled
    ? {
        enabled: true,
        accessToken: requireEnv("GOOGLE_ACCESS_TOKEN"),
        developerToken: requireEnv("GOOGLE_DEVELOPER_TOKEN"),
        customerId: requireEnv("GOOGLE_CUSTOMER_ID"),
        loginCustomerId: optionalEnv("GOOGLE_LOGIN_CUSTOMER_ID") || undefined,
        conversionActionResourceName: requireEnv(
          "GOOGLE_CONVERSION_ACTION_RESOURCE_NAME"
        ),
        apiVersion: optionalEnv("GOOGLE_API_VERSION", "v17"),
      }
    : {
        enabled: false,
        accessToken: "",
        developerToken: "",
        customerId: "",
        loginCustomerId: undefined,
        conversionActionResourceName: "",
        apiVersion: optionalEnv("GOOGLE_API_VERSION", "v17"),
      };

  if (!meta.enabled && !google.enabled) {
    throw new Error(
      "No destination enabled. Set META_ENABLED=true and/or GOOGLE_ENABLED=true."
    );
  }

  return {
    port: Number.isFinite(port) ? port : 8080,
    allowedOrigins,
    sharedSecret: optionalEnv("RELAY_SHARED_SECRET"),
    phoneCountryCode: optionalEnv("PHONE_COUNTRY_CODE", DEFAULT_PHONE_COUNTRY_CODE),
    capi: {
      meta,
      google,
      requestTimeoutMs: Number.parseInt(optionalEnv("REQUEST_TIMEOUT_MS", "8000"), 10) || 8000,
    },
    retry: {
      maxAttempts: intEnv("RETRY_MAX_ATTEMPTS", 4),
      baseDelayMs: intEnv("RETRY_BASE_DELAY_MS", 500),
      maxDelayMs: intEnv("RETRY_MAX_DELAY_MS", 30_000),
      factor: intEnv("RETRY_FACTOR", 2),
      jitter: boolEnv("RETRY_JITTER", true),
      concurrency: intEnv("RETRY_CONCURRENCY", 8),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Request validation                                                          */
/* -------------------------------------------------------------------------- */

/** Raw inbound body shape from the client tracker. */
interface InboundEventBody {
  event_name?: unknown;
  event_id?: unknown;
  event_time?: unknown;
  event_source_url?: unknown;
  value?: unknown;
  currency?: unknown;
  user_data?: {
    email?: unknown;
    phone?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    city?: unknown;
    country?: unknown;
    fbp?: unknown;
    fbc?: unknown;
    client_user_agent?: unknown;
  };
}

/** A validation failure with a safe, PII-free message. */
class ValidationError extends Error {}

/** Narrows an unknown value to a non-empty trimmed string, or returns null. */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Narrows an unknown to a string or null (without emptiness requirement). */
function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Validates and coerces the inbound body into a strongly-typed object the
 * relay can act on. Throws ValidationError on any structural problem.
 * Note: PII fields are intentionally NOT validated for content, only presence.
 */
function parseInbound(body: InboundEventBody): {
  eventName: string;
  eventId: string;
  eventTime: number;
  eventSourceUrl: string;
  value: number;
  currency: string;
  user: {
    email: string | null;
    phone: string | null;
    first_name: string | null;
    last_name: string | null;
    city: string | null;
    country: string | null;
  };
  fbp: string | null;
  fbc: string | null;
  clientUserAgent: string | null;
} {
  const eventId = asNonEmptyString(body.event_id);
  if (!eventId) {
    throw new ValidationError("Field 'event_id' is required.");
  }

  const currency = asNonEmptyString(body.currency);
  if (!currency) {
    throw new ValidationError("Field 'currency' is required.");
  }
  if (!/^[A-Za-z]{3}$/.test(currency)) {
    throw new ValidationError("Field 'currency' must be a 3-letter ISO-4217 code.");
  }

  const rawValue = body.value;
  const numericValue =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string"
      ? Number.parseFloat(rawValue.replace(/[^0-9.\-]/g, ""))
      : NaN;
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new ValidationError("Field 'value' must be a non-negative number.");
  }

  // event_time: accept client-supplied seconds, else stamp server time.
  let eventTime: number;
  if (typeof body.event_time === "number" && Number.isFinite(body.event_time)) {
    eventTime = Math.floor(body.event_time);
  } else {
    eventTime = Math.floor(Date.now() / 1000);
  }
  // Guard against millisecond timestamps sent by mistake (> year 5138 in sec).
  if (eventTime > 1_000_000_000_000) {
    eventTime = Math.floor(eventTime / 1000);
  }

  const userData = body.user_data ?? {};
  const email = asNonEmptyString(userData.email);
  const phone = asNonEmptyString(userData.phone);

  // At least one strong identifier is required for a usable match.
  if (!email && !phone) {
    throw new ValidationError(
      "At least one of user_data.email or user_data.phone is required."
    );
  }

  return {
    eventName: asNonEmptyString(body.event_name) ?? "Purchase",
    eventId,
    eventTime,
    eventSourceUrl: asNonEmptyString(body.event_source_url) ?? "",
    value: numericValue,
    currency: currency.toUpperCase(),
    user: {
      email,
      phone,
      first_name: asNonEmptyString(userData.first_name),
      last_name: asNonEmptyString(userData.last_name),
      city: asNonEmptyString(userData.city),
      country: asNonEmptyString(userData.country),
    },
    fbp: asNullableString(userData.fbp),
    fbc: asNullableString(userData.fbc),
    clientUserAgent: asNullableString(userData.client_user_agent),
  };
}

/**
 * Best-effort client IP extraction honoring common proxy headers.
 * Returns null when unavailable. (Used only to improve Meta match quality.)
 */
function extractClientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0];
    if (first) {
      const trimmed = first.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return req.ip ?? null;
}

/* -------------------------------------------------------------------------- */
/* App assembly                                                                */
/* -------------------------------------------------------------------------- */

/** The assembled application plus the handles a host needs for shutdown. */
export interface AssembledApp {
  app: express.Express;
  retryQueue: RetryQueue;
}

/** Builds the configured Express application, dispatch service, and retry queue. */
export function createApp(config: AppConfig): AssembledApp {
  const app = express();
  const capi = new CapiService(config.capi);

  // Background retry queue for transient upstream failures (no external infra).
  const retryQueue = new RetryQueue(config.retry, {
    onRetry: (ctx, _error, nextDelayMs) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[retry] ${ctx.label} attempt ${ctx.attempt}/${ctx.maxAttempts} failed; ` +
          `retrying in ${nextDelayMs}ms`
      );
    },
    onGiveUp: (ctx) => {
      // eslint-disable-next-line no-console
      console.error(
        `[retry] ${ctx.label} exhausted ${ctx.maxAttempts} attempts; giving up.`
      );
    },
    onSuccess: (ctx) => {
      if (ctx.attempt > 1) {
        // eslint-disable-next-line no-console
        console.info(`[retry] ${ctx.label} succeeded on attempt ${ctx.attempt}.`);
      }
    },
  });

  // Trust the first proxy hop (Vercel/Heroku/NGINX) so req.ip is meaningful.
  app.set("trust proxy", true);

  // Strict JSON body parsing with a small cap — events are tiny.
  app.use(express.json({ limit: "32kb" }));

  // CORS: when an allow-list is provided, enforce it; otherwise reflect origin.
  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      // Non-browser / same-origin requests have no Origin header — allow them.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (config.allowedOrigins.length === 0) {
        // No allow-list configured: permissive (dev). Lock this down in prod.
        callback(null, true);
        return;
      }
      if (config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Relay-Secret"],
    maxAge: 86400,
  };
  app.use(cors(corsOptions));

  // Serve the compiled browser tracker (if present) for one-line embedding.
  app.use(
    "/tracker.js",
    express.static(path.join(__dirname, "..", "client", "tracker.js"), {
      maxAge: "1h",
      fallthrough: true,
    })
  );

  // Liveness/readiness probe. Reports which destinations are enabled — no PII.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      meta_enabled: config.capi.meta.enabled,
      google_enabled: config.capi.google.enabled,
      time: new Date().toISOString(),
    });
  });

  // Main relay endpoint.
  app.post("/api/events", async (req: Request, res: Response) => {
    // Optional shared-secret gate to prevent open relaying.
    if (config.sharedSecret.length > 0) {
      const provided = req.header("X-Relay-Secret") ?? "";
      if (provided !== config.sharedSecret) {
        res.status(401).json({ ok: false, error: "Unauthorized." });
        return;
      }
    }

    let parsed: ReturnType<typeof parseInbound>;
    try {
      parsed = parseInbound((req.body ?? {}) as InboundEventBody);
    } catch (error) {
      const message =
        error instanceof ValidationError ? error.message : "Invalid request body.";
      // Log ONLY the safe message — never the body (it contains raw PII).
      // eslint-disable-next-line no-console
      console.warn(`[relay] 400 validation: ${message}`);
      res.status(400).json({ ok: false, error: message });
      return;
    }

    // ---- Zero-knowledge boundary -----------------------------------------
    // Raw PII is hashed here and immediately discarded. `parsed.user` (raw)
    // is never logged, stored, or forwarded beyond this line.
    const hashedUser = hashUserData(parsed.user, config.phoneCountryCode);
    // ----------------------------------------------------------------------

    const event: ConversionEvent = {
      eventName: parsed.eventName,
      eventId: parsed.eventId,
      eventTime: parsed.eventTime,
      eventSourceUrl: parsed.eventSourceUrl,
      value: parsed.value,
      currency: parsed.currency,
      user: hashedUser,
      fbp: parsed.fbp,
      fbc: parsed.fbc,
      clientUserAgent: parsed.clientUserAgent,
      clientIpAddress: extractClientIp(req),
    };

    try {
      const summary = await capi.dispatch(event);
      const anyOk = summary.results.some((r) => r.ok);
      const anyHardFailure = summary.results.some((r) => !r.ok && !r.skipped);

      // Schedule background retries for every platform that hard-failed. We only
      // re-send to the failed destination (never the one that already accepted),
      // so deduplication via event_id is preserved end-to-end.
      for (const result of summary.results) {
        if (result.ok || result.skipped) {
          continue;
        }
        const platform = result.platform;
        retryQueue.enqueue(`${platform}:${event.eventId}`, async () => {
          const retried = await capi.dispatchToPlatform(platform, event);
          if (!retried.ok && !retried.skipped) {
            // Throw to signal the queue this attempt failed and should back off.
            throw new Error(retried.message);
          }
        });
      }

      // 200 when at least one platform accepted; 502 when every active platform
      // failed; the per-platform breakdown is always returned for observability.
      const httpStatus = anyOk ? 200 : anyHardFailure ? 502 : 200;
      res.status(httpStatus).json({
        ok: anyOk,
        event_id: summary.eventId,
        results: summary.results.map((r) => ({
          platform: r.platform,
          ok: r.ok,
          skipped: r.skipped,
          status: r.status ?? null,
          message: r.message,
        })),
      });
    } catch (error) {
      // Defensive catch — dispatch() isolates per-platform errors internally,
      // so reaching here implies an unexpected bug. Keep the response generic.
      // eslint-disable-next-line no-console
      console.error(
        `[relay] 500 dispatch error event_id=${parsed.eventId}:`,
        error instanceof Error ? error.message : String(error)
      );
      res.status(500).json({ ok: false, error: "Internal dispatch error." });
    }
  });

  // 404 for anything else.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: "Not found." });
  });

  // Centralized error handler (e.g. CORS rejections, body-parse failures).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(`[relay] error: ${err.message}`);
    if (res.headersSent) {
      return;
    }
    const isCors = err.message.startsWith("Origin not allowed by CORS");
    res.status(isCors ? 403 : 400).json({ ok: false, error: err.message });
  });

  return { app, retryQueue };
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                   */
/* -------------------------------------------------------------------------- */

/** Starts the server. Exported so tests can import createApp without listening. */
function main(): void {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[relay] Configuration error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
    return;
  }

  const { app, retryQueue } = createApp(config);
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.info(
      `[relay] OneClick CAPI Connector listening on :${config.port} ` +
        `(meta=${config.capi.meta.enabled} google=${config.capi.google.enabled})`
    );
  });

  // Graceful shutdown so in-flight relays and pending retries can complete.
  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.info(
      `[relay] ${signal} received, shutting down… (${retryQueue.size()} retries pending)`
    );
    server.close(() => {
      // Allow already-scheduled retries a brief window to drain, then exit.
      const drain = Promise.race([
        retryQueue.onIdle(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
      ]);
      void drain.then(() => {
        // eslint-disable-next-line no-console
        console.info("[relay] closed. bye.");
        process.exit(0);
      });
    });
    // Force-exit if connections linger.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only auto-start when executed directly (not when imported by a test).
if (require.main === module) {
  main();
}
