/**
 * HTTP integration tests for the Express relay.
 *
 * axios is fully mocked, so NO real network calls are made — we drive the app
 * through supertest and assert on status codes and response bodies across the
 * validation, auth (401), success (200), and total-failure (502) paths.
 *
 * The retry queue is configured with maxAttempts=1 so failed dispatches give up
 * immediately (no lingering timers). Each test drains the queue via onIdle().
 */

import axios from "axios";
import request from "supertest";
import { createApp, type AppConfig, type AssembledApp } from "../index";

jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;
const post = jest.fn();

/** Builds an app config with both platforms; tweak via overrides. */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    allowedOrigins: [],
    sharedSecret: "",
    phoneCountryCode: "81",
    capi: {
      meta: {
        enabled: true,
        pixelId: "1234567890",
        accessToken: "META_TOKEN",
        testEventCode: undefined,
        apiVersion: "v21.0",
      },
      google: {
        enabled: false,
        accessToken: "",
        developerToken: "",
        customerId: "",
        loginCustomerId: undefined,
        conversionActionResourceName: "",
        apiVersion: "v17",
      },
      requestTimeoutMs: 8000,
    },
    // maxAttempts=1 => no scheduled retries => no open timers in tests.
    retry: {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 5,
      factor: 2,
      jitter: false,
      concurrency: 4,
    },
    ...overrides,
  };
}

/** A minimal valid event body the client tracker would POST. */
function validBody(): Record<string, unknown> {
  return {
    event_name: "Purchase",
    event_id: "order_1001",
    event_time: 1_719_446_400,
    event_source_url: "https://shop.example.com/thank-you",
    value: 12800,
    currency: "JPY",
    user_data: {
      email: "customer@example.com",
      phone: "090-1234-5678",
    },
  };
}

let assembled: AssembledApp;

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.create.mockReturnValue({ post } as unknown as ReturnType<
    typeof axios.create
  >);
  (mockedAxios.isAxiosError as unknown as jest.Mock).mockImplementation(
    (err: unknown) =>
      Boolean(err && typeof err === "object" && (err as { isAxiosError?: boolean }).isAxiosError)
  );
});

afterEach(async () => {
  if (assembled) {
    // Drain/clear any background retries so Jest exits cleanly.
    assembled.retryQueue.clear();
    await assembled.retryQueue.onIdle();
  }
});

describe("GET /healthz", () => {
  it("returns ok and the enabled destinations", async () => {
    assembled = createApp(makeConfig());
    const res = await request(assembled.app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      meta_enabled: true,
      google_enabled: false,
    });
  });
});

describe("POST /api/events — validation (400)", () => {
  beforeEach(() => {
    assembled = createApp(makeConfig());
  });

  it("rejects a missing event_id", async () => {
    const body = validBody();
    delete body["event_id"];
    const res = await request(assembled.app).post("/api/events").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/event_id/);
  });

  it("rejects a malformed currency (not 3 letters)", async () => {
    const body = { ...validBody(), currency: "JP" };
    const res = await request(assembled.app).post("/api/events").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/currency/);
  });

  it("rejects a negative value", async () => {
    const body = { ...validBody(), value: -5 };
    const res = await request(assembled.app).post("/api/events").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/value/);
  });

  it("rejects when neither email nor phone is provided", async () => {
    const body = { ...validBody(), user_data: {} };
    const res = await request(assembled.app).post("/api/events").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email or user_data.phone/);
  });

  it("does not call the upstream API on a validation failure", async () => {
    const body = validBody();
    delete body["currency"];
    await request(assembled.app).post("/api/events").send(body);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("POST /api/events — auth (401)", () => {
  it("rejects a request without the shared secret when one is configured", async () => {
    assembled = createApp(makeConfig({ sharedSecret: "s3cr3t" }));
    const res = await request(assembled.app).post("/api/events").send(validBody());
    expect(res.status).toBe(401);
  });

  it("accepts a request with the correct shared secret", async () => {
    post.mockResolvedValue({ status: 200, data: { events_received: 1 } });
    assembled = createApp(makeConfig({ sharedSecret: "s3cr3t" }));
    const res = await request(assembled.app)
      .post("/api/events")
      .set("X-Relay-Secret", "s3cr3t")
      .send(validBody());
    expect(res.status).toBe(200);
    await assembled.retryQueue.onIdle();
  });
});

describe("POST /api/events — success (200)", () => {
  it("relays to Meta and returns a per-platform breakdown", async () => {
    post.mockResolvedValue({
      status: 200,
      data: { events_received: 1, fbtrace_id: "TRACE" },
    });
    assembled = createApp(makeConfig());

    const res = await request(assembled.app).post("/api/events").send(validBody());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.event_id).toBe("order_1001");
    const meta = res.body.results.find(
      (r: { platform: string }) => r.platform === "meta"
    );
    const google = res.body.results.find(
      (r: { platform: string }) => r.platform === "google"
    );
    expect(meta.ok).toBe(true);
    expect(google.skipped).toBe(true);

    // The raw email must never appear in the relay's response.
    expect(JSON.stringify(res.body)).not.toContain("customer@example.com");

    await assembled.retryQueue.onIdle();
  });
});

describe("POST /api/events — all platforms fail (502)", () => {
  it("returns 502 when every active destination hard-fails", async () => {
    post.mockRejectedValue({
      isAxiosError: true,
      message: "upstream down",
      response: { status: 503, data: {} },
    });
    assembled = createApp(makeConfig());

    const res = await request(assembled.app).post("/api/events").send(validBody());

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    const meta = res.body.results.find(
      (r: { platform: string }) => r.platform === "meta"
    );
    expect(meta.ok).toBe(false);
    expect(meta.skipped).toBe(false);

    await assembled.retryQueue.onIdle();
  });
});

describe("DRY-RUN mode (no credentials needed)", () => {
  it("accepts and hashes the event without calling any upstream API", async () => {
    const config = makeConfig();
    config.capi.dryRun = true;
    // Simulate a credential-less deploy.
    config.capi.meta.pixelId = "DRYRUN";
    config.capi.meta.accessToken = "DRYRUN";
    assembled = createApp(config);

    const res = await request(assembled.app).post("/api/events").send(validBody());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const meta = res.body.results.find(
      (r: { platform: string }) => r.platform === "meta"
    );
    expect(meta.ok).toBe(true);
    expect(meta.message).toMatch(/DRY-RUN/);

    // Crucially: no real network call was made.
    expect(post).not.toHaveBeenCalled();
    // And no raw PII leaked into the response.
    expect(JSON.stringify(res.body)).not.toContain("customer@example.com");

    await assembled.retryQueue.onIdle();
  });

  it("reports dry_run=true on /healthz", async () => {
    const config = makeConfig();
    config.capi.dryRun = true;
    assembled = createApp(config);
    const res = await request(assembled.app).get("/healthz");
    expect(res.body.dry_run).toBe(true);
  });
});

describe("unknown routes", () => {
  it("returns 404 with a JSON error", async () => {
    assembled = createApp(makeConfig());
    const res = await request(assembled.app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
