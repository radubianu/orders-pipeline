import { test } from "node:test";
import assert from "node:assert/strict";
import { shopifyOrderTxnDate } from "../src/lib/orderDate";

test("extracts the date from an ISO timestamp with a negative offset", () => {
  assert.equal(shopifyOrderTxnDate("2026-09-15T10:23:45-04:00"), "2026-09-15");
});

test("extracts the date from a UTC (Z) timestamp", () => {
  assert.equal(shopifyOrderTxnDate("2026-01-02T23:59:59Z"), "2026-01-02");
});
