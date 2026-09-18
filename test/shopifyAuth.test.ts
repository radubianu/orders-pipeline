import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyShopifyHmac } from "../src/lib/shopifyAuth";

const SECRET = "test-client-secret";

function sign(body: Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

test("accepts a correctly signed body", () => {
  const body = Buffer.from(JSON.stringify({ id: 123, line_items: [] }));
  const header = sign(body, SECRET);
  assert.equal(verifyShopifyHmac(body, header, SECRET), true);
});

test("rejects a tampered body", () => {
  const body = Buffer.from(JSON.stringify({ id: 123 }));
  const header = sign(body, SECRET);
  const tampered = Buffer.from(JSON.stringify({ id: 456 }));
  assert.equal(verifyShopifyHmac(tampered, header, SECRET), false);
});

test("rejects wrong secret", () => {
  const body = Buffer.from(JSON.stringify({ id: 123 }));
  const header = sign(body, "wrong-secret");
  assert.equal(verifyShopifyHmac(body, header, SECRET), false);
});

test("rejects missing header", () => {
  const body = Buffer.from(JSON.stringify({ id: 123 }));
  assert.equal(verifyShopifyHmac(body, undefined, SECRET), false);
});

test("rejects malformed base64 header without throwing", () => {
  const body = Buffer.from(JSON.stringify({ id: 123 }));
  assert.equal(verifyShopifyHmac(body, "not-valid-base64!!!", SECRET), false);
});

test("rejects header of different length without throwing", () => {
  const body = Buffer.from(JSON.stringify({ id: 123 }));
  assert.equal(verifyShopifyHmac(body, "c2hvcnQ=", SECRET), false);
});
