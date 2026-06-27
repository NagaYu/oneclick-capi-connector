/**
 * Tests for the strict normalizer — the module that guarantees our SHA-256
 * hashes are byte-identical to what Meta/Google compute. A single regression
 * here silently destroys ad match quality, so these assertions are exhaustive.
 */

import { createHash } from "node:crypto";
import {
  toHalfWidth,
  sha256Hex,
  normalizeEmail,
  normalizePhone,
  normalizePhoneE164,
  normalizeName,
  normalizeCountry,
  hashEmail,
  hashPhone,
  hashPhoneE164,
  hashUserData,
} from "../normalizer";

/** Local reference hasher to cross-check the module's output independently. */
function refSha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("toHalfWidth", () => {
  it("converts full-width ASCII variants to half-width", () => {
    expect(toHalfWidth("ＡＢＣ１２３")).toBe("ABC123");
  });

  it("converts the ideographic space to a normal space", () => {
    expect(toHalfWidth("a　b")).toBe("a b");
  });

  it("converts full-width @ and . used in emails", () => {
    expect(toHalfWidth("ｕｓｅｒ＠ｔｅｓｔ．ｃｏｍ")).toBe("user@test.com");
  });

  it("leaves half-width and non-ASCII characters untouched", () => {
    expect(toHalfWidth("abc-東京")).toBe("abc-東京");
  });
});

describe("sha256Hex", () => {
  it("matches a known SHA-256 vector for a normalized email", () => {
    expect(sha256Hex("customer@example.com")).toBe(
      "e233d4a29013e9d87150c6237c6777bedf379ebf1acdc5d6126fec7e8bb74fb5"
    );
  });

  it("agrees with an independent crypto reference", () => {
    expect(sha256Hex("hello")).toBe(refSha256("hello"));
  });
});

describe("normalizeEmail", () => {
  it("trims, lowercases, and half-width-normalizes", () => {
    expect(normalizeEmail("  Ｃustomer@Example.COM ")).toBe("customer@example.com");
  });

  it("normalizes a fully full-width email", () => {
    expect(normalizeEmail("ｕｓｅｒ＠ｔｅｓｔ．ｃｏｍ")).toBe("user@test.com");
  });

  it("does NOT strip Gmail dots or +tags (must mirror platform spec)", () => {
    expect(normalizeEmail("First.Last+promo@Gmail.com")).toBe(
      "first.last+promo@gmail.com"
    );
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it("rejects structurally invalid emails", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("a@@b.com")).toBeNull();
    expect(normalizeEmail("@nope.com")).toBeNull();
    expect(normalizeEmail("trailing@dot.")).toBeNull();
  });
});

describe("normalizePhone (Meta form, digits only)", () => {
  it("strips hyphens/spaces and replaces leading 0 with country code 81", () => {
    expect(normalizePhone("090-1234-5678")).toBe("819012345678");
  });

  it("handles full-width digits", () => {
    expect(normalizePhone("０９０１２３４５６７８")).toBe("819012345678");
  });

  it("drops the + on an international number", () => {
    expect(normalizePhone("+81 90 1234 5678")).toBe("819012345678");
  });

  it("keeps an already-prefixed country code without a leading 0", () => {
    expect(normalizePhone("819012345678")).toBe("819012345678");
  });

  it("prepends the country code when none is detectable", () => {
    // No +, no leading 0, no cc prefix → treat as national subscriber number.
    expect(normalizePhone("9012345678")).toBe("819012345678");
  });

  it("honors a non-Japan country code argument", () => {
    expect(normalizePhone("(202) 555-0147", "1")).toBe("12025550147");
  });

  it("returns null when no digits remain", () => {
    expect(normalizePhone("----")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("normalizePhoneE164 (Google form, + prefix)", () => {
  it("returns +<cc><number>", () => {
    expect(normalizePhoneE164("090-1234-5678")).toBe("+819012345678");
  });

  it("returns null for empty input", () => {
    expect(normalizePhoneE164("")).toBeNull();
  });
});

describe("normalizeName / normalizeCountry", () => {
  it("lowercases, trims, collapses whitespace for names", () => {
    expect(normalizeName("  Ｊohn   Doe  ")).toBe("john doe");
  });

  it("returns a 2-letter lowercase country code", () => {
    expect(normalizeCountry(" JP ")).toBe("jp");
    expect(normalizeCountry("Japan")).toBeNull(); // not 2 letters
    expect(normalizeCountry("U.S")).toBe("us"); // punctuation stripped → 2 letters
    expect(normalizeCountry("USA")).toBeNull(); // 3 letters → invalid
  });
});

describe("hash convenience helpers", () => {
  it("hashEmail equals sha256 of the normalized email", () => {
    expect(hashEmail("  Customer@Example.com ")).toBe(
      refSha256("customer@example.com")
    );
  });

  it("hashPhone (Meta) and hashPhoneE164 (Google) differ by the + prefix", () => {
    expect(hashPhone("090-1234-5678")).toBe(refSha256("819012345678"));
    expect(hashPhoneE164("090-1234-5678")).toBe(refSha256("+819012345678"));
    expect(hashPhone("090-1234-5678")).not.toBe(hashPhoneE164("090-1234-5678"));
  });

  it("returns null for absent inputs rather than hashing an empty string", () => {
    expect(hashEmail(null)).toBeNull();
    expect(hashPhone(undefined)).toBeNull();
  });
});

describe("hashUserData", () => {
  it("hashes every present field and nulls every absent one", () => {
    const result = hashUserData({
      email: "Customer@Example.com",
      phone: "090-1234-5678",
      first_name: "John",
      last_name: "Doe",
      city: "Tokyo",
      country: "JP",
    });

    expect(result.email).toBe(refSha256("customer@example.com"));
    expect(result.phone_meta).toBe(refSha256("819012345678"));
    expect(result.phone_google).toBe(refSha256("+819012345678"));
    expect(result.first_name).toBe(refSha256("john"));
    expect(result.last_name).toBe(refSha256("doe"));
    expect(result.city).toBe(refSha256("tokyo"));
    expect(result.country).toBe(refSha256("jp"));
  });

  it("never leaks raw PII onto the returned object", () => {
    const result = hashUserData({ email: "secret@example.com" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret@example.com");
    expect(result.phone_meta).toBeNull();
    expect(result.phone_google).toBeNull();
  });
});
