import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decomposeLineItem,
  BundleMap,
  ShopifyLineItem,
} from "../src/lib/bundleDecomposition";

// BUNDLE-COFFEE-KIT: 1x mug (ref $12.00) + 2x coffee bag (ref $9.50 each)
// + 1x coaster (ref $4.00). Total weight = 12 + 19 + 4 = 35.
// Matches scripts/seed.ts so the hand-worked numbers below double as a
// sanity check on the seed data.
const bundleMap: BundleMap = new Map([
  [
    "BUNDLE-COFFEE-KIT",
    [
      { componentSku: "SKU-MUG", qtyPerBundle: 1, referencePrice: 12.0 },
      { componentSku: "SKU-COFFEE-BAG", qtyPerBundle: 2, referencePrice: 9.5 },
      { componentSku: "SKU-COASTER", qtyPerBundle: 1, referencePrice: 4.0 },
    ],
  ],
]);

test("non-bundle SKU passes through unchanged", () => {
  const line: ShopifyLineItem = {
    sku: "SKU-TSHIRT",
    quantity: 2,
    price: "20.00",
  };
  const result = decomposeLineItem(line, bundleMap);
  assert.deepEqual(result, [
    { sku: "SKU-TSHIRT", quantity: 2, unitPrice: 20.0, amount: 40.0 },
  ]);
});

test("non-bundle SKU nets a line-level discount into unit price", () => {
  // $20 x 2 = $40 gross, $8 line discount -> $32 net over qty 2 = $16/unit.
  const line: ShopifyLineItem = {
    sku: "SKU-TSHIRT",
    quantity: 2,
    price: "20.00",
    discount_allocations: [{ amount: "8.00" }],
  };
  const result = decomposeLineItem(line, bundleMap);
  assert.deepEqual(result, [
    { sku: "SKU-TSHIRT", quantity: 2, unitPrice: 16.0, amount: 32.0 },
  ]);
});

test("bundle with no discount splits proportionally to reference weight", () => {
  // Hand-worked: bundle sells for $30, qty 1, no discount.
  // MUG:  12/35 * 30 = 10.285714 -> $10.29 (qty 1)
  // BAG:  19/35 * 30 = 16.285714 / 2 units -> $8.142857 -> $8.14 (qty 2)
  // COAST: 4/35 * 30 =  3.428571 -> $3.43 (qty 1)
  const line: ShopifyLineItem = {
    sku: "BUNDLE-COFFEE-KIT",
    quantity: 1,
    price: "30.00",
  };
  const result = decomposeLineItem(line, bundleMap);
  assert.deepEqual(result, [
    { sku: "SKU-MUG", quantity: 1, unitPrice: 10.29, amount: 10.29 },
    { sku: "SKU-COFFEE-BAG", quantity: 2, unitPrice: 8.14, amount: 16.28 },
    { sku: "SKU-COASTER", quantity: 1, unitPrice: 3.43, amount: 3.43 },
  ]);
  const sum = result.reduce((s, l) => s + l.amount, 0);
  assert.equal(round2(sum), 30.0);
});

test("bundle with a line-level discount allocates proportionally after netting", () => {
  // Same bundle, but Shopify applied a $3 discount to this line (e.g. a
  // storewide 10% automatic discount). netLineTotal = 30 - 3 = 27.
  // Raw (pre-rounding) cents: MUG 926.57, BAG 1465.71, COASTER 308.57.
  // Floors sum to 2699c against a 2700c target, so the one leftover cent
  // goes to BAG (largest fractional remainder, .71) -- MUG and COASTER
  // (tied at .57) don't get it. This is the reconciliation guarantee: the
  // three lines always sum to exactly the netted line total, never $27.01.
  const line: ShopifyLineItem = {
    sku: "BUNDLE-COFFEE-KIT",
    quantity: 1,
    price: "30.00",
    discount_allocations: [{ amount: "3.00" }],
  };
  const result = decomposeLineItem(line, bundleMap);
  assert.deepEqual(result, [
    { sku: "SKU-MUG", quantity: 1, unitPrice: 9.26, amount: 9.26 },
    { sku: "SKU-COFFEE-BAG", quantity: 2, unitPrice: 7.33, amount: 14.66 },
    { sku: "SKU-COASTER", quantity: 1, unitPrice: 3.08, amount: 3.08 },
  ]);
  const sum = result.reduce((s, l) => s + l.amount, 0);
  assert.equal(round2(sum), 27.0);
});

test("multiple bundles on one line scale unit prices consistently", () => {
  // 2 bundles at $30 each, no discount -- per-unit component prices should
  // match the single-bundle case, just with doubled quantities. The
  // leftover-cent reconciliation now shifts one cent from MUG to BAG
  // relative to naive independent rounding (20.58/32.56 -> 20.57/32.57),
  // but the total still lands on exactly $60.00 and unit prices are
  // unchanged from the single-bundle case.
  const line: ShopifyLineItem = {
    sku: "BUNDLE-COFFEE-KIT",
    quantity: 2,
    price: "30.00",
  };
  const result = decomposeLineItem(line, bundleMap);
  assert.deepEqual(result, [
    { sku: "SKU-MUG", quantity: 2, unitPrice: 10.29, amount: 20.57 },
    { sku: "SKU-COFFEE-BAG", quantity: 4, unitPrice: 8.14, amount: 32.57 },
    { sku: "SKU-COASTER", quantity: 2, unitPrice: 3.43, amount: 6.86 },
  ]);
});

test("bundle with zero total reference weight throws", () => {
  const badMap: BundleMap = new Map([
    [
      "BUNDLE-BROKEN",
      [{ componentSku: "SKU-X", qtyPerBundle: 1, referencePrice: 0 }],
    ],
  ]);
  const line: ShopifyLineItem = {
    sku: "BUNDLE-BROKEN",
    quantity: 1,
    price: "10.00",
  };
  assert.throws(() => decomposeLineItem(line, badMap));
});

test("regression: reference weights that don't divide evenly still reconcile to the exact line total", () => {
  // Real production case that surfaced the rounding bug: independent
  // per-component rounding produced 70.23 + 87.46 + 22.30 = $179.99 on a
  // $180.00 bundle with no discount at all. Weights: 80.30 + 25.50 + 100.
  const map: BundleMap = new Map([
    [
      "BKS-2026-01",
      [
        { componentSku: "AD-02-1-white", qtyPerBundle: 1, referencePrice: 80.3 },
        { componentSku: "FF-01-m-black", qtyPerBundle: 1, referencePrice: 25.5 },
        { componentSku: "H-01-OS-black", qtyPerBundle: 1, referencePrice: 100.0 },
      ],
    ],
  ]);
  const line: ShopifyLineItem = {
    sku: "BKS-2026-01",
    quantity: 1,
    price: "180.00",
  };
  const result = decomposeLineItem(line, map);
  const sum = result.reduce((s, l) => s + l.amount, 0);
  assert.equal(round2(sum), 180.0);
});

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
