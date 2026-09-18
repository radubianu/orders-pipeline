import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs } from "../src/lib/backoff";

test("backoff schedule is 1min, 5min, 30min then holds", () => {
  assert.equal(backoffMs(1), 1 * 60 * 1000);
  assert.equal(backoffMs(2), 5 * 60 * 1000);
  assert.equal(backoffMs(3), 30 * 60 * 1000);
  assert.equal(backoffMs(4), 30 * 60 * 1000);
  assert.equal(backoffMs(10), 30 * 60 * 1000);
});
