-- Idempotency ledger for Shopify webhook deliveries.
-- Keyed on webhook_id, not order_id: order_id recurs legitimately across
-- topics (orders/create, orders/updated, orders/cancelled all touch the
-- same order), so it can't be the sole dedup key.
CREATE TABLE processed_webhooks (
  webhook_id  TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Maps a bundle/kit SKU to its component SKUs for order-line decomposition.
-- reference_price is the relative weight used to split the bundle line's
-- net price across components (typically each component's standalone unit
-- price) -- not necessarily the price it's synced to QBO at.
CREATE TABLE bundle_components (
  id              SERIAL PRIMARY KEY,
  bundle_sku      TEXT NOT NULL,
  component_sku   TEXT NOT NULL,
  qty_per_bundle  NUMERIC NOT NULL,
  reference_price NUMERIC NOT NULL,
  UNIQUE (bundle_sku, component_sku)
);

-- Maps a Shopify SKU (bundle or plain) to the QuickBooks Online Item it
-- should be synced as.
CREATE TABLE sku_qbo_item_map (
  sku           TEXT PRIMARY KEY,
  qbo_item_id   TEXT NOT NULL,
  qbo_item_name TEXT
);

-- Sync state for each Shopify order, keyed on shopify_order_id (unique per
-- order regardless of how many webhook deliveries reference it).
CREATE TABLE order_sync_log (
  id                SERIAL PRIMARY KEY,
  shopify_order_id  BIGINT NOT NULL UNIQUE,
  shopify_webhook_id TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'success', 'failed', 'dead')),
  order_payload     JSONB NOT NULL,
  qbo_doc_id        TEXT,
  error_message     TEXT,
  retry_count       INT NOT NULL DEFAULT 0,
  max_retries       INT NOT NULL DEFAULT 5,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker's claim query filters on (status, next_attempt_at, retry_count);
-- this index keeps that scan cheap as the table grows.
CREATE INDEX order_sync_log_poll_idx
  ON order_sync_log (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
