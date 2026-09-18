import { test } from "node:test";
import assert from "node:assert/strict";
import { claimWebhook, Queryable } from "../src/lib/idempotency";

// Fake Queryable backed by a Set, standing in for the real
// INSERT ... ON CONFLICT DO NOTHING against processed_webhooks.
function fakeDb(): Queryable {
  const seen = new Set<string>();
  return {
    async query(_text: string, params?: unknown[]) {
      const webhookId = params?.[0] as string;
      if (seen.has(webhookId)) return { rowCount: 0 };
      seen.add(webhookId);
      return { rowCount: 1 };
    },
  };
}

test("first claim of a webhook_id succeeds", async () => {
  const db = fakeDb();
  const claimed = await claimWebhook(db, "wh-1", "orders/create");
  assert.equal(claimed, true);
});

test("second claim of the same webhook_id fails", async () => {
  const db = fakeDb();
  await claimWebhook(db, "wh-1", "orders/create");
  const claimed = await claimWebhook(db, "wh-1", "orders/create");
  assert.equal(claimed, false);
});

test("different webhook_ids each claim independently", async () => {
  const db = fakeDb();
  assert.equal(await claimWebhook(db, "wh-1", "orders/create"), true);
  assert.equal(await claimWebhook(db, "wh-2", "orders/create"), true);
});
