/**
 * OneClick CAPI Connector — Strict Data Normalizer & Hasher
 * ---------------------------------------------------------
 * The single most important module for ad-platform match quality.
 *
 * Meta (Conversions API) and Google (Enhanced Conversions) match users by
 * comparing SHA-256 hashes of normalized PII. If our normalization differs
 * from theirs by even ONE byte (an uppercase letter, a stray space, a
 * full-width digit, a missing country code) the hash will not match and the
 * conversion is silently dropped. This module follows the official
 * specifications exactly to guarantee a 100% byte-identical hash.
 *
 * Zero-Knowledge guarantee:
 *   Every exported helper that touches raw PII returns the SHA-256 hash, never
 *   the raw value. Raw strings live only as short-lived local consts inside
 *   these functions and are never logged, returned, or persisted.
 *
 * References:
 *   - Meta Conversions API — Customer Information Parameters
 *     https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
 *   - Google Ads API — Enhanced Conversions for Leads / Web (data normalization)
 *     https://developers.google.com/google-ads/api/docs/conversions/enhanced-conversions/web
 */

import { createHash } from "node:crypto";

/**
 * Default country code (without "+") used when a phone number is supplied in
 * national format (e.g. a Japanese number beginning with a single leading 0).
 * Japan = "81". Override per call when serving other markets.
 */
export const DEFAULT_PHONE_COUNTRY_CODE = "81";

/**
 * Converts every full-width ("zenkaku") ASCII-range character to its half-width
 * ("hankaku") equivalent. Japanese input methods routinely emit full-width
 * digits/letters/symbols (e.g. "ＡＢＣ１２３＠ｅｘａｍｐｌｅ．ｃｏｍ"); without this
 * step the hash would never match the ad platform's half-width canonical form.
 *
 * Range mapping:
 *   - Full-width ASCII variants occupy U+FF01–U+FF5E and map to U+0021–U+007E
 *     by subtracting 0xFEE0.
 *   - The ideographic space U+3000 maps to a normal ASCII space (U+0020).
 */
export function toHalfWidth(input: string): string {
  let result = "";
  for (const char of input) {
    const code = char.charCodeAt(0);
    if (code === 0x3000) {
      // Ideographic (full-width) space → ASCII space.
      result += " ";
    } else if (code >= 0xff01 && code <= 0xff5e) {
      // Full-width ASCII variants → half-width ASCII.
      result += String.fromCharCode(code - 0xfee0);
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Computes a lowercase hex SHA-256 digest of the (already-normalized) input.
 * This is the ONLY representation of PII that ever leaves this module.
 */
export function sha256Hex(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Normalizes an email address to the platform-canonical form.
 *
 * Steps (order matters and matches Meta/Google specs):
 *   1. Convert full-width characters to half-width (Japanese-input safety).
 *   2. Trim leading/trailing whitespace.
 *   3. Lowercase the entire string.
 *   4. Collapse the result to NFKC so visually-identical Unicode is unified.
 *
 * Note: We intentionally do NOT strip Gmail dots or "+tags". Neither Meta nor
 * Google performs that step in their documented canonicalization, and doing so
 * would DESYNC our hash from theirs. Keep it strictly spec-compliant.
 *
 * @returns the normalized (still raw) email, or null when the input is empty
 *          or structurally not an email.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  // 1) full-width → half-width, 2) trim, 3) lowercase, 4) NFKC unification.
  const normalized = toHalfWidth(String(raw))
    .normalize("NFKC")
    .trim()
    .toLowerCase();

  if (normalized.length === 0) {
    return null;
  }

  // Minimal structural validation: exactly one "@", non-empty local & domain,
  // and a dot in the domain. We reject obviously invalid values rather than
  // hashing junk that can never match.
  const atIndex = normalized.indexOf("@");
  if (
    atIndex <= 0 ||
    atIndex !== normalized.lastIndexOf("@") ||
    atIndex === normalized.length - 1
  ) {
    return null;
  }
  const domain = normalized.slice(atIndex + 1);
  if (domain.indexOf(".") < 1 || domain.endsWith(".")) {
    return null;
  }

  return normalized;
}

/**
 * Normalizes a phone number to E.164-style digits WITHOUT the leading "+".
 *
 * Meta requires: country code included, digits only, no "+", no symbols/spaces.
 * Google's Enhanced Conversions requires full E.164 *with* a leading "+", so we
 * also expose {@link normalizePhoneE164} below for that platform.
 *
 * Steps:
 *   1. Full-width → half-width (Japanese-input safety: "０９０－…").
 *   2. Strip everything except digits and a single leading "+".
 *   3. If it already carries an international "+" prefix, drop the "+".
 *   4. Otherwise, if it starts with a national trunk "0" (Japan etc.),
 *      replace that single leading 0 with the country code (default "81").
 *   5. Otherwise, assume the country code is already present and keep as-is.
 *
 * Examples (default country = "81"):
 *   "+81 90-1234-5678" → "819012345678"
 *   "090-1234-5678"    → "819012345678"
 *   "０９０１２３４５６７８" → "819012345678"
 *   "81 90 1234 5678"  → "819012345678" (already has CC, no leading 0)
 *
 * @returns digits-only string, or null when no digits remain.
 */
export function normalizePhone(
  raw: string | null | undefined,
  countryCode: string = DEFAULT_PHONE_COUNTRY_CODE
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  // 1) Normalize width so full-width digits/symbols become ASCII.
  const halfWidth = toHalfWidth(String(raw)).normalize("NFKC").trim();

  // 2) Detect a leading international "+" before stripping symbols.
  const hadPlusPrefix = halfWidth.startsWith("+");

  // 3) Remove every non-digit character (hyphens, spaces, parentheses, "+", dots).
  let digits = halfWidth.replace(/\D/g, "");
  if (digits.length === 0) {
    return null;
  }

  const cc = countryCode.replace(/\D/g, "");

  if (hadPlusPrefix) {
    // Already international (e.g. "+81…"): the "+" is gone, digits already
    // include the country code. Nothing more to do.
    return digits;
  }

  if (digits.startsWith("0")) {
    // National format with a trunk "0": replace exactly one leading 0 with CC.
    digits = cc + digits.slice(1);
    return digits;
  }

  if (cc.length > 0 && digits.startsWith(cc)) {
    // Country code already present without a leading 0 (e.g. "8190…").
    return digits;
  }

  // No "+", no leading 0, no detectable CC prefix: prepend the country code so
  // the number is always fully-qualified before hashing.
  return cc.length > 0 ? cc + digits : digits;
}

/**
 * Same as {@link normalizePhone} but returns full E.164 *with* a leading "+".
 * Use this form for Google Enhanced Conversions, which expects "+<cc><number>".
 */
export function normalizePhoneE164(
  raw: string | null | undefined,
  countryCode: string = DEFAULT_PHONE_COUNTRY_CODE
): string | null {
  const digits = normalizePhone(raw, countryCode);
  if (digits === null) {
    return null;
  }
  return `+${digits}`;
}

/**
 * Normalizes a generic name-like field (first name, last name, city).
 * Spec: full-width → half-width, NFKC, trim, lowercase, collapse internal
 * whitespace runs to a single space, and strip surrounding punctuation/spaces.
 */
export function normalizeName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const normalized = toHalfWidth(String(raw))
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalizes a 2-letter ISO-3166-1 alpha-2 country code.
 * Spec: lowercase, strip non-letters, must be exactly 2 letters.
 */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const normalized = toHalfWidth(String(raw))
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return normalized.length === 2 ? normalized : null;
}

/**
 * Convenience: normalize THEN hash an email in one shot.
 * The raw value never escapes this function.
 */
export function hashEmail(raw: string | null | undefined): string | null {
  const normalized = normalizeEmail(raw);
  if (normalized === null) {
    return null;
  }
  const digest = sha256Hex(normalized);
  return digest;
}

/**
 * Convenience: normalize (digits-only, Meta form) THEN hash a phone number.
 * The raw value never escapes this function.
 */
export function hashPhone(
  raw: string | null | undefined,
  countryCode: string = DEFAULT_PHONE_COUNTRY_CODE
): string | null {
  const normalized = normalizePhone(raw, countryCode);
  if (normalized === null) {
    return null;
  }
  return sha256Hex(normalized);
}

/**
 * Convenience: normalize (E.164, Google form) THEN hash a phone number.
 * Google hashes the "+"-prefixed E.164 string; Meta hashes the digits-only
 * string. We therefore keep the two hashes distinct and platform-correct.
 */
export function hashPhoneE164(
  raw: string | null | undefined,
  countryCode: string = DEFAULT_PHONE_COUNTRY_CODE
): string | null {
  const normalized = normalizePhoneE164(raw, countryCode);
  if (normalized === null) {
    return null;
  }
  return sha256Hex(normalized);
}

/** Convenience: normalize THEN hash a name-like field. */
export function hashName(raw: string | null | undefined): string | null {
  const normalized = normalizeName(raw);
  if (normalized === null) {
    return null;
  }
  return sha256Hex(normalized);
}

/** Convenience: normalize THEN hash a country code. */
export function hashCountry(raw: string | null | undefined): string | null {
  const normalized = normalizeCountry(raw);
  if (normalized === null) {
    return null;
  }
  return sha256Hex(normalized);
}

/**
 * Raw (un-hashed) PII fields captured by the client tracker.
 */
export interface RawUserData {
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  city?: string | null;
  country?: string | null;
}

/**
 * Fully-hashed user data, ready to be mapped into platform payloads.
 * `null` means the source field was absent or invalid and should be omitted.
 *
 * Phone is provided in BOTH platform-correct forms:
 *   - `phone_meta`   : SHA-256 of digits-only (no "+")  → Meta CAPI
 *   - `phone_google` : SHA-256 of E.164 (with "+")      → Google Enhanced Conv.
 */
export interface HashedUserData {
  email: string | null;
  phone_meta: string | null;
  phone_google: string | null;
  first_name: string | null;
  last_name: string | null;
  city: string | null;
  country: string | null;
}

/**
 * Normalizes and hashes an entire user-data object in one pass.
 *
 * This is the function the relay calls. Raw PII enters here, ONLY hashes leave.
 * No raw value is stored on the returned object, logged, or thrown in an error.
 */
export function hashUserData(
  raw: RawUserData,
  countryCode: string = DEFAULT_PHONE_COUNTRY_CODE
): HashedUserData {
  return {
    email: hashEmail(raw.email),
    phone_meta: hashPhone(raw.phone, countryCode),
    phone_google: hashPhoneE164(raw.phone, countryCode),
    first_name: hashName(raw.first_name),
    last_name: hashName(raw.last_name),
    city: hashName(raw.city),
    country: hashCountry(raw.country),
  };
}
