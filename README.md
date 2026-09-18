# orders-pipeline

Syncs Shopify orders to QuickBooks Online as they come in, with one
differentiator: **bundle decomposition**. If a Shopify order sells a
bundle/kit SKU, this service splits it into its individual component line
items on the QuickBooks side — so your books show what was actually sold,
not an opaque "Bundle X" line — with proportional, discount-aware price
splitting down to the cent.

Built as a portfolio piece to demonstrate hand-built Shopify/QuickBooks
integration work: real OAuth2, real webhook verification, real retry
durability, no integration platform in between.

## Why bundle decomposition

Say a store sells a "Back-to-School Kit" bundle for $180, made of three
components normally priced at $80.30 / $25.50 / $100.00 standalone. A naive
sync just books one $180 line against a generic "Bundle" item. This service
instead books three lines, proportional to each component's reference
price:

| Component | Reference price | Weight | QBO line amount |
|---|---|---|---|
| AD-02-1-white | 80.30 | 80.30 / 205.80 | $70.23 |
| H-01-OS-black | 100.00 | 100.00 / 205.80 | $87.47 |
| FF-01-m-black | 25.50 | 25.50 / 205.80 | $22.30 |

**$70.23 + $87.47 + $22.30 = $180.00 exactly.** Rounding each component's
share to the cent independently can drift the sum away from what Shopify
actually charged (this really happened during testing — see
[`src/lib/bundleDecomposition.ts`](src/lib/bundleDecomposition.ts)), so the
split uses a largest-remainder allocation: floor every component's raw
share, then hand out the leftover pennies to whichever components rounded
down the most. The receipt total always reconciles exactly.

Line-level Shopify discounts are netted in before the split, using
`discount_allocations` on the specific line (not the order-level discount
total, which wouldn't isolate what applies to that one line).

## Architecture

One Fly.io app, two process groups sharing one Postgres database (Neon):

```
Shopify ──POST──▶ web (always-on)                    worker (scale-to-zero)
                    │  1. verify HMAC                    │
                    │  2. claim webhook_id (idempotent)   │  poll order_sync_log
                    │  3. insert order_sync_log row       │  (FOR UPDATE SKIP LOCKED)
                    │     (BEFORE acking — see below)     │
                    │  4. ack 200                         │  decompose bundle lines
                    │  5. wake worker via Machines API ───▶│  call QBO SalesReceipt API
                    └──────────────────────────────────    │  mark success/failed/dead
                                                             │  exit when queue is empty
```

- **`web`** (`src/server.ts`) handles the `orders/create` webhook and the
  one-time QuickBooks OAuth flow. It's always-on (`min_machines_running =
  1`) because Shopify's 5-second webhook timeout doesn't leave a safe
  margin against Fly's cold-start latency.
- **`worker`** (`src/worker.ts`) does the actual QuickBooks sync. It's
  scale-to-zero: it polls for work, drains everything due, and calls
  `process.exit(0)` once the queue is truly empty (not just empty *right
  now* — see the comment in `worker.ts` for the exit-condition fix this
  went through). The web process wakes it via the Fly Machines API after
  every new order.
- **No queue system.** Retry durability lives entirely in Postgres —
  `order_sync_log` rows track status, retry count, and exponential backoff
  (1min → 5min → 30min, capped at `max_retries` before going `dead`).
  `FOR UPDATE SKIP LOCKED` is what makes plain polling safe if the worker
  is ever scaled beyond one Machine.
- **Two separate tables** for idempotency (`processed_webhooks`, keyed on
  Shopify's `webhook_id`) and sync state (`order_sync_log`, keyed on
  `shopify_order_id`) — kept apart deliberately, because a `shopify_order_id`
  will legitimately recur if `orders/updated` or `orders/cancelled` webhooks
  are ever added, so it can't be the sole idempotency key.
- **Pre-ack durability.** The order is written to `order_sync_log` *before*
  responding 200 to Shopify. Acking first would create a window where a
  crash loses the order with zero trace, since Shopify won't retry a
  delivery it already got a 200 for.

## Stack

Node.js + TypeScript, Express, Postgres (Neon, via a plain `DATABASE_URL` —
no Neon-specific tooling), deployed on Fly.io. No Redis, no message queue.

## Project layout

```
src/
  server.ts              web process: webhook route + QBO OAuth routes
  worker.ts               worker process: poll/decompose/sync/retry loop
  lib/
    bundleDecomposition.ts  the core differentiator (see above)
    shopifyAuth.ts           HMAC verification
    idempotency.ts           webhook dedup claim
    qboOAuth.ts              QBO OAuth2 (auth URL, code exchange, refresh)
    quickbooks.ts            SalesReceipt API client
    flyMachines.ts           wakes the worker Machine
    backoff.ts               retry backoff schedule
    orderDate.ts             Shopify created_at -> QBO TxnDate
  db/pool.ts               shared pg Pool
migrations/                 plain SQL, run in filename order
scripts/
  migrate.ts                minimal migration runner
  seed.ts                   example bundle_components / sku_qbo_item_map rows
test/                       node:test unit tests (no DB/network required)
```

## Local development

```bash
cp .env.example .env   # fill in DATABASE_URL, SHOPIFY_API_SECRET, QBO_* creds
npm install
npm run migrate
npm run seed            # inserts example bundle + item-map rows -- adjust to your own QBO sandbox
npm run typecheck
npm test
npm run dev:web          # http://localhost:3000
npm run dev:worker       # separate terminal
```

To connect QuickBooks locally, visit `http://localhost:3000/quickbooks/connect`
(requires `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET` from an Intuit developer app,
and that same redirect URI registered on the app). Tokens are stored in
`qbo_tokens` and refreshed automatically — QBO refresh tokens rotate on
every use and expire after 100 days, both handled in `qboOAuth.ts`.

## Database schema

- `processed_webhooks (webhook_id PK, topic, received_at)` — idempotency.
- `order_sync_log (shopify_order_id UNIQUE, status, order_payload, retry_count, next_attempt_at, ...)` — sync state and retry bookkeeping.
- `bundle_components (bundle_sku, component_sku, qty_per_bundle, reference_price)` — the bundle -> components map.
- `sku_qbo_item_map (sku PK, qbo_item_id)` — Shopify SKU -> QBO Item.
- `qbo_tokens (realm_id PK, access_token, refresh_token, expiries...)` — OAuth token storage.

## Deployment (Fly.io)

One Fly app, two process groups defined in `fly.toml`. `web` runs under
`[http_service]` (always-on); `worker` deliberately has no `[http_service]`
block, since Fly's proxy-based autostop assumes request/response traffic and
would risk killing a polling background job mid-work.

```bash
flyctl deploy
```

**Known gotcha:** `fly.toml` has no field that actually pins a Machine's
restart policy — a `restart.policy` key under `[[vm]]` validates but is
silently ignored by flyctl. Every full `flyctl deploy` that touches the
worker resets it to Fly's default (`on-failure`, 10 retries), so after each
such deploy:

```bash
flyctl machine update <worker-machine-id> --restart no
```

Without this, Fly could restart the worker after a normal empty-queue exit,
defeating the "only the web process wakes it" design.

## License

MIT — see [LICENSE](LICENSE).
