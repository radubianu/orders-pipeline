// Shopify's created_at is a full ISO 8601 timestamp with the store's local
// UTC offset already baked in (e.g. "2026-09-15T10:23:45-04:00"). QBO's
// TxnDate wants a plain "yyyy-MM-dd". Slicing the string directly (rather
// than round-tripping through `Date`, which normalizes to UTC and can push
// the date to the next/previous day depending on the offset) preserves the
// date the merchant actually saw on the order.
export function shopifyOrderTxnDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}
