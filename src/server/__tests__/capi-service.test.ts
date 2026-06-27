/**
 * Tests for the dispatch service. axios is fully mocked so NO network calls
 * occur; we assert on the exact payload shape and headers sent to each platform
 * plus correct success/failure mapping.
 */

import axios from "axios";
import { createHash } from "node:crypto";
import {
  CapiService,
  formatGoogleDateTime,
  type CapiServiceConfig,
  type ConversionEvent,
} from "../capi-service";
import { hashUserData } from "../normalizer";

jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;

/** The mock POST function the created axios instance will expose. */
const post = jest.fn();

function refSha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Builds a baseline config with both platforms enabled. */
function makeConfig(overrides: Partial<CapiServiceConfig> = {}): CapiServiceConfig {
  return {
    meta: {
      enabled: true,
      pixelId: "1234567890",
      accessToken: "META_TOKEN",
      testEventCode: undefined,
      apiVersion: "v21.0",
    },
    google: {
      enabled: true,
      accessToken: "GOOGLE_TOKEN",
      developerToken: "DEV_TOKEN",
      customerId: "111-222-3333",
      loginCustomerId: "999-888-7777",
      conversionActionResourceName: "customers/1112223333/conversionActions/55",
      apiVersion: "v17",
    },
    requestTimeoutMs: 8000,
    ...overrides,
  };
}

/** Builds a sample event with hashed user data. */
function makeEvent(): ConversionEvent {
  return {
    eventName: "Purchase",
    eventId: "order_1001",
    eventTime: 1_719_446_400, // 2024-06-27T00:00:00Z
    eventSourceUrl: "https://shop.example.com/thank-you",
    value: 12800,
    currency: "JPY",
    user: hashUserData({ email: "customer@example.com", phone: "090-1234-5678" }),
    fbp: "fb.1.1719446400.123",
    fbc: "fb.1.1719446400.abc",
    clientUserAgent: "Mozilla/5.0",
    clientIpAddress: "203.0.113.7",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // CapiService calls axios.create() in its constructor.
  mockedAxios.create.mockReturnValue({ post } as unknown as ReturnType<
    typeof axios.create
  >);
  // describeError() relies on axios.isAxiosError.
  (mockedAxios.isAxiosError as unknown as jest.Mock).mockImplementation(
    (err: unknown) =>
      Boolean(err && typeof err === "object" && (err as { isAxiosError?: boolean }).isAxiosError)
  );
});

describe("CapiService → Meta", () => {
  it("posts a correctly mapped Meta CAPI payload and reports success", async () => {
    post.mockResolvedValue({
      status: 200,
      data: { events_received: 1, fbtrace_id: "TRACE123" },
    });

    const service = new CapiService(makeConfig({ google: { ...makeConfig().google, enabled: false } }));
    const result = await service.dispatchToPlatform("meta", makeEvent());

    expect(result.ok).toBe(true);
    expect(result.platform).toBe("meta");
    expect(result.status).toBe(200);

    expect(post).toHaveBeenCalledTimes(1);
    const [url, payload, requestConfig] = post.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { params?: Record<string, unknown> }
    ];

    expect(url).toBe("https://graph.facebook.com/v21.0/1234567890/events");
    expect(requestConfig.params).toEqual({ access_token: "META_TOKEN" });

    const data = (payload["data"] as Array<Record<string, unknown>>)[0]!;
    expect(data["event_name"]).toBe("Purchase");
    expect(data["event_id"]).toBe("order_1001");
    expect(data["action_source"]).toBe("website");

    const userData = data["user_data"] as Record<string, unknown>;
    // Email and phone are sent as arrays of the lowercase hex hashes.
    expect(userData["em"]).toEqual([refSha256("customer@example.com")]);
    // Meta gets the digits-only hash (NOT the +E.164 one).
    expect(userData["ph"]).toEqual([refSha256("819012345678")]);
    expect(userData["fbp"]).toBe("fb.1.1719446400.123");
    expect(userData["fbc"]).toBe("fb.1.1719446400.abc");
    expect(userData["client_user_agent"]).toBe("Mozilla/5.0");
    expect(userData["client_ip_address"]).toBe("203.0.113.7");

    const customData = data["custom_data"] as Record<string, unknown>;
    expect(customData).toEqual({ value: 12800, currency: "JPY" });
  });

  it("includes test_event_code when configured", async () => {
    post.mockResolvedValue({ status: 200, data: { events_received: 1 } });
    const config = makeConfig({
      meta: { ...makeConfig().meta, testEventCode: "TEST123" },
      google: { ...makeConfig().google, enabled: false },
    });
    const service = new CapiService(config);
    await service.dispatchToPlatform("meta", makeEvent());

    const payload = post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload["test_event_code"]).toBe("TEST123");
  });

  it("maps an axios error into a failed, PII-free result", async () => {
    post.mockRejectedValue({
      isAxiosError: true,
      message: "Request failed with status code 400",
      response: {
        status: 400,
        data: { error: { message: "Invalid parameter" } },
      },
    });

    const service = new CapiService(makeConfig({ google: { ...makeConfig().google, enabled: false } }));
    const result = await service.dispatchToPlatform("meta", makeEvent());

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.status).toBe(400);
    expect(result.message).toContain("Invalid parameter");
  });
});

describe("CapiService → Google", () => {
  it("posts a correctly mapped Enhanced Conversions payload", async () => {
    post.mockResolvedValue({ status: 200, data: { results: [{}] } });

    const service = new CapiService(makeConfig({ meta: { ...makeConfig().meta, enabled: false } }));
    const result = await service.dispatchToPlatform("google", makeEvent());

    expect(result.ok).toBe(true);
    expect(result.platform).toBe("google");

    const [url, payload, requestConfig] = post.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { headers?: Record<string, string> }
    ];

    // customerId has its dashes stripped for the URL.
    expect(url).toBe(
      "https://googleads.googleapis.com/v17/customers/1112223333:uploadClickConversions"
    );
    expect(requestConfig.headers?.["Authorization"]).toBe("Bearer GOOGLE_TOKEN");
    expect(requestConfig.headers?.["developer-token"]).toBe("DEV_TOKEN");
    expect(requestConfig.headers?.["login-customer-id"]).toBe("9998887777");

    const conversion = (payload["conversions"] as Array<Record<string, unknown>>)[0]!;
    expect(conversion["conversionAction"]).toBe(
      "customers/1112223333/conversionActions/55"
    );
    expect(conversion["conversionValue"]).toBe(12800);
    expect(conversion["currencyCode"]).toBe("JPY");
    expect(conversion["orderId"]).toBe("order_1001");
    expect(conversion["conversionDateTime"]).toBe("2024-06-27 00:00:00+00:00");

    const identifiers = conversion["userIdentifiers"] as Array<Record<string, unknown>>;
    // Google gets the +E.164 phone hash (NOT the digits-only one).
    expect(identifiers).toContainEqual({ hashedEmail: refSha256("customer@example.com") });
    expect(identifiers).toContainEqual({
      hashedPhoneNumber: refSha256("+819012345678"),
    });
  });

  it("treats a 200 with partialFailureError as a failure", async () => {
    post.mockResolvedValue({
      status: 200,
      data: { partialFailureError: { message: "conversionAction is invalid" } },
    });

    const service = new CapiService(makeConfig({ meta: { ...makeConfig().meta, enabled: false } }));
    const result = await service.dispatchToPlatform("google", makeEvent());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("conversionAction is invalid");
  });
});

describe("CapiService.dispatch (both platforms)", () => {
  it("dispatches to both and isolates a single-platform failure", async () => {
    post
      .mockResolvedValueOnce({ status: 200, data: { events_received: 1 } }) // meta ok
      .mockRejectedValueOnce({
        isAxiosError: true,
        message: "boom",
        response: { status: 500, data: {} },
      }); // google fails

    const service = new CapiService(makeConfig());
    const summary = await service.dispatch(makeEvent());

    const meta = summary.results.find((r) => r.platform === "meta");
    const google = summary.results.find((r) => r.platform === "google");
    expect(meta?.ok).toBe(true);
    expect(google?.ok).toBe(false);
    expect(google?.skipped).toBe(false);
  });

  it("marks a disabled platform as skipped without calling axios", async () => {
    const service = new CapiService(
      makeConfig({ google: { ...makeConfig().google, enabled: false } })
    );
    post.mockResolvedValue({ status: 200, data: { events_received: 1 } });

    const summary = await service.dispatch(makeEvent());
    const google = summary.results.find((r) => r.platform === "google");
    expect(google?.skipped).toBe(true);
    // Only Meta should have triggered a POST.
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("formatGoogleDateTime", () => {
  it("formats unix seconds as Google's RFC-3339-ish UTC string", () => {
    expect(formatGoogleDateTime(1_719_446_400)).toBe("2024-06-27 00:00:00+00:00");
  });
});
