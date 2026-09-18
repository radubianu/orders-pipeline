// Worker process: scale-to-zero. Polls order_sync_log, decomposes bundle
// line items, syncs each order to QBO as a SalesReceipt, and retries with
// backoff on failure. Exits itself (process.exit(0)) once there is truly
// nothing left to do; fly.toml must NOT auto-restart it after that clean
// exit -- only the web process's Fly Machines "start" call brings it back.
import "./env";
import { PoolClient } from "pg";
import { pool } from "./db/pool";
import {
  decomposeLineItem,
  BundleMap,
  ShopifyLineItem,
} from "./lib/bundleDecomposition";
import { createSalesReceipt, QboLineInput } from "./lib/quickbooks";
import { backoffMs } from "./lib/backoff";
import { shopifyOrderTxnDate } from "./lib/orderDate";

// Fixed short re-poll cadence used once no row is due *right now* but at
// least one pending/failed row still exists (possibly with a future
// next_attempt_at). A fixed cadence also naturally catches any new order
// that lands in the meantime -- a precise single-row sleep wouldn't.
const IDLE_RECHECK_MS = 20_000;

interface OrderSyncRow {
  id: number;
  shopify_order_id: string;
  order_payload: { id: number; created_at: string; line_items?: unknown[] };
  retry_count: number;
  max_retries: number;
}

async function loadBundleMap(): Promise<BundleMap> {
  const { rows } = await pool.query<{
    bundle_sku: string;
    component_sku: string;
    qty_per_bundle: string;
    reference_price: string;
  }>(
    "SELECT bundle_sku, component_sku, qty_per_bundle, reference_price FROM bundle_components"
  );

  const map: BundleMap = new Map();
  for (const row of rows) {
    const components = map.get(row.bundle_sku) ?? [];
    components.push({
      componentSku: row.component_sku,
      qtyPerBundle: Number(row.qty_per_bundle),
      referencePrice: Number(row.reference_price),
    });
    map.set(row.bundle_sku, components);
  }
  return map;
}

async function loadSkuItemMap(): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ sku: string; qbo_item_id: string }>(
    "SELECT sku, qbo_item_id FROM sku_qbo_item_map"
  );
  return new Map(rows.map((r) => [r.sku, r.qbo_item_id]));
}

function toShopifyLineItem(raw: unknown): ShopifyLineItem {
  const li = raw as {
    sku: string;
    quantity: number;
    price: string;
    discount_allocations?: { amount: string }[];
  };
  return {
    sku: li.sku,
    quantity: li.quantity,
    price: li.price,
    discount_allocations: li.discount_allocations,
  };
}

function buildQboLines(
  order: OrderSyncRow["order_payload"],
  bundleMap: BundleMap,
  skuItemMap: Map<string, string>
): QboLineInput[] {
  const lineItems = (order.line_items ?? []).map(toShopifyLineItem);
  const decomposed = lineItems.flatMap((line) =>
    decomposeLineItem(line, bundleMap)
  );

  return decomposed.map((line) => {
    const qboItemId = skuItemMap.get(line.sku);
    if (!qboItemId) {
      throw new Error(`no sku_qbo_item_map entry for SKU "${line.sku}"`);
    }
    return {
      qboItemId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
    };
  });
}

type ClaimOutcome = "processed" | "empty";

/**
 * Claims and processes one due row. The SELECT FOR UPDATE SKIP LOCKED lock
 * is held for the entire processing of the row -- including the QBO API
 * call -- inside a single transaction, since order_sync_log has no
 * "processing" status to mark a row as claimed-but-in-flight. This is a
 * deliberate simplicity trade-off at this traffic level (no queue system);
 * it means a stuck QBO call holds one DB connection until it resolves,
 * which is fine for a single low-volume worker.
 */
async function claimAndProcessOne(client: PoolClient): Promise<ClaimOutcome> {
  await client.query("BEGIN");

  const { rows } = await client.query<OrderSyncRow>(
    `SELECT id, shopify_order_id, order_payload, retry_count, max_retries
     FROM order_sync_log
     WHERE status IN ('pending', 'failed')
       AND next_attempt_at <= now()
       AND retry_count < max_retries
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1`
  );
  const row = rows[0];

  if (!row) {
    await client.query("COMMIT");
    return "empty";
  }

  try {
    const bundleMap = await loadBundleMap();
    const skuItemMap = await loadSkuItemMap();
    const lines = buildQboLines(row.order_payload, bundleMap, skuItemMap);
    const txnDate = shopifyOrderTxnDate(row.order_payload.created_at);
    const result = await createSalesReceipt(lines, txnDate);

    await client.query(
      `UPDATE order_sync_log
       SET status = 'success', qbo_doc_id = $2, error_message = NULL, updated_at = now()
       WHERE id = $1`,
      [row.id, result.qboDocId]
    );
    await client.query("COMMIT");
    console.log(
      `order ${row.shopify_order_id}: synced as QBO SalesReceipt ${result.qboDocId}`
    );
  } catch (err) {
    const nextRetryCount = row.retry_count + 1;
    const exhausted = nextRetryCount >= row.max_retries;
    const message = err instanceof Error ? err.message : String(err);

    await client.query(
      `UPDATE order_sync_log
       SET status = $2,
           retry_count = $3,
           next_attempt_at = now() + ($4 || ' milliseconds')::interval,
           error_message = $5,
           updated_at = now()
       WHERE id = $1`,
      [
        row.id,
        exhausted ? "dead" : "failed",
        nextRetryCount,
        backoffMs(nextRetryCount),
        message,
      ]
    );
    await client.query("COMMIT");
    console.error(
      `order ${row.shopify_order_id}: sync attempt ${nextRetryCount} failed${
        exhausted ? " (max retries exhausted, marked dead)" : ""
      }: ${message}`
    );
  }

  return "processed";
}

async function anyPendingOrFailedRowExists(): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM order_sync_log WHERE status IN ('pending', 'failed') LIMIT 1`
  );
  return rows.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const client = await pool.connect();
  try {
    while (true) {
      const outcome = await claimAndProcessOne(client);
      if (outcome === "processed") {
        continue; // more rows may be due right now -- keep draining
      }

      // Nothing due *right now*. Only exit if truly nothing is
      // pending/failed at all -- a row with a future next_attempt_at must
      // keep the worker alive so its backoff eventually gets serviced.
      if (!(await anyPendingOrFailedRowExists())) {
        console.log("worker: queue empty, exiting");
        break;
      }

      console.log(
        `worker: nothing due yet, rechecking in ${IDLE_RECHECK_MS / 1000}s`
      );
      await sleep(IDLE_RECHECK_MS);
    }
  } finally {
    client.release();
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("worker crashed:", err);
  process.exit(1);
});
