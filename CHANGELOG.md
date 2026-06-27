# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-27

### Added
- **Client tracker** (`src/client/tracker.ts`): one-line embeddable browser
  script for the Thank-You page. Captures email, phone, value, currency, and a
  deduplication `event_id`; reads Meta `_fbp`/`_fbc` cookies; sends via
  `navigator.sendBeacon` with a `fetch` + timeout fallback.
- **Strict normalizer** (`src/server/normalizer.ts`): spec-compliant data
  cleansing and SHA-256 hashing. Full-width→half-width conversion, NFKC,
  email lowercasing, phone digit-stripping with leading-`0`→country-code
  replacement (default Japan `81`). Emits Meta (digits-only) and Google (E.164)
  phone hash forms separately.
- **Dispatch service** (`src/server/capi-service.ts`): maps hashed user data
  onto Meta Conversions API and Google Ads Enhanced Conversions payloads and
  POSTs them with axios. Per-platform isolation, PII-free structured logging.
- **Express relay** (`src/server/index.ts`): `POST /api/events` and `GET
  /healthz`, CORS allow-list, optional shared-secret gate, graceful shutdown.
- **In-process retry queue** (`src/server/retry-queue.ts`): dependency-free
  exponential backoff with jitter and bounded concurrency; failed destinations
  are retried individually to preserve `event_id` deduplication.
- **Tests**: Jest unit suites for the normalizer, retry queue, and dispatch
  service, plus a supertest HTTP integration suite for the relay
  (validation / 401 / 200 / 502 paths).
- **Tooling**: `tsconfig.json` (`strict: true`, `target: es2022`),
  GitHub Actions CI (type-check + test + build on Node 18/20/22),
  `vercel.json`, `.env.example`, MIT `LICENSE`.

[1.0.0]: https://github.com/NagaYu/oneclick-capi-connector/releases/tag/v1.0.0
