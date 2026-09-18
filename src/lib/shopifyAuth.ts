import crypto from "node:crypto";

/**
 * Verifies Shopify's X-Shopify-Hmac-Sha256 header against the raw request
 * body. Must run on the exact bytes Shopify sent (before any JSON parsing/
 * re-serialization, which can reorder keys or change whitespace and break
 * the signature) and use a constant-time comparison to avoid a timing
 * side-channel on the digest check.
 */
export function verifyShopifyHmac(
  rawBody: Buffer,
  hmacHeader: string | undefined,
  clientSecret: string
): boolean {
  if (!hmacHeader) return false;

  const computed = crypto
    .createHmac("sha256", clientSecret)
    .update(rawBody)
    .digest("base64");

  const expected = Buffer.from(computed, "base64");
  let received: Buffer;
  try {
    received = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }

  // timingSafeEqual throws on length mismatch rather than returning false,
  // and an attacker-controlled header could be any length.
  if (expected.length !== received.length) return false;

  return crypto.timingSafeEqual(expected, received);
}
