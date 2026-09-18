export interface DiscountAllocation {
  amount: string; // Shopify sends money as decimal strings, e.g. "3.00"
}

export interface ShopifyLineItem {
  sku: string;
  quantity: number;
  price: string; // per-unit price, decimal string, before discounts
  discount_allocations?: DiscountAllocation[];
}

export interface BundleComponent {
  componentSku: string;
  qtyPerBundle: number;
  referencePrice: number;
}

/** bundleSku -> its components. Loaded from the bundle_components table. */
export type BundleMap = Map<string, BundleComponent[]>;

export interface DecomposedLine {
  sku: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

/**
 * Expands one Shopify line item into one or more QBO lines. A non-bundle
 * SKU (no entry in bundleMap) passes through unchanged, just with its
 * per-line discount netted into the price. A bundle SKU is split into its
 * components, each priced proportionally to
 * (component.referencePrice * component.qtyPerBundle) against the sum of
 * that weight across all components.
 */
export function decomposeLineItem(
  line: ShopifyLineItem,
  bundleMap: BundleMap
): DecomposedLine[] {
  const components = bundleMap.get(line.sku);

  const grossLineTotal = Number(line.price) * line.quantity;
  const discountTotal = (line.discount_allocations ?? []).reduce(
    (sum, d) => sum + Number(d.amount),
    0
  );
  const netLineTotal = grossLineTotal - discountTotal;

  if (!components || components.length === 0) {
    // Not a bundle: pass through, netting the line-level discount into
    // the unit price so the QBO line still reflects what the customer
    // actually paid.
    const netUnitPrice = round2(netLineTotal / line.quantity);
    return [
      {
        sku: line.sku,
        quantity: line.quantity,
        unitPrice: netUnitPrice,
        amount: round2(netUnitPrice * line.quantity),
      },
    ];
  }

  const totalWeight = components.reduce(
    (sum, c) => sum + c.referencePrice * c.qtyPerBundle,
    0
  );
  if (totalWeight <= 0) {
    throw new Error(
      `bundle "${line.sku}" has zero or negative total reference weight -- check bundle_components`
    );
  }

  // Total units of each component sold = bundles sold * qty per bundle.
  // Rounding each component's share to the cent independently can drift
  // the sum away from netLineTotal by a cent or two (e.g. 70.23 + 87.46 +
  // 22.30 = 179.99 on a $180 bundle) -- QBO's receipt total must match
  // what Shopify actually charged, so allocate whole cents with the
  // largest-remainder method: floor every share, then hand the leftover
  // pennies to whichever components rounded down the most.
  const targetCents = Math.round(netLineTotal * 100);
  const shares = components.map((c) => {
    const weight = c.referencePrice * c.qtyPerBundle;
    const totalComponentUnits = c.qtyPerBundle * line.quantity;
    const rawCents = (netLineTotal * (weight / totalWeight)) * 100;
    // Nudge by a tiny epsilon before flooring so float error (e.g.
    // 8746.999999999999 instead of 8747) doesn't shave off a cent.
    const flooredCents = Math.floor(rawCents + 1e-7);
    return {
      componentSku: c.componentSku,
      totalComponentUnits,
      cents: flooredCents,
      remainder: rawCents - flooredCents,
    };
  });

  const allocatedCents = shares.reduce((sum, s) => sum + s.cents, 0);
  const leftoverCents = targetCents - allocatedCents;
  const byLargestRemainder = [...shares].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < leftoverCents; i++) {
    byLargestRemainder[i % byLargestRemainder.length]!.cents += 1;
  }

  return shares.map((s) => ({
    sku: s.componentSku,
    quantity: s.totalComponentUnits,
    unitPrice: round2(s.cents / 100 / s.totalComponentUnits),
    amount: s.cents / 100,
  }));
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
