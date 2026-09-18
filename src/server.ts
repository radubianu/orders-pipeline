// Web process: always-on (no scale-to-zero). Handles the Shopify webhook
// (step 6, not yet wired here) and the one-time QuickBooks OAuth flow.
import "./env";
import crypto from "node:crypto";
import express from "express";

const app = express();

// --- QuickBooks OAuth2 (sandbox) -------------------------------------
// One-time, single-operator setup flow -- not the high-volume webhook
// path -- so an in-memory CSRF state store is fine; it doesn't need to
// survive a restart.
import { buildAuthorizeUrl, exchangeCodeForTokens } from "./lib/qboOAuth";

const pendingOAuthStates = new Map<string, number>(); // state -> expiry (ms)
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

app.get("/quickbooks/connect", (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  pendingOAuthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  res.redirect(buildAuthorizeUrl(state));
});

app.get("/quickbooks/callback", async (req, res) => {
  const { code, state, realmId, error } = req.query;

  if (error) {
    res.status(400).send(`QuickBooks authorization error: ${error}`);
    return;
  }

  const expiry = typeof state === "string" ? pendingOAuthStates.get(state) : undefined;
  if (!expiry || Date.now() > expiry) {
    res.status(400).send("invalid or expired OAuth state");
    return;
  }
  pendingOAuthStates.delete(state as string);

  if (typeof code !== "string" || typeof realmId !== "string") {
    res.status(400).send("missing code or realmId in callback");
    return;
  }

  try {
    await exchangeCodeForTokens(code, realmId);
    res.send("QuickBooks connected. You can close this tab.");
  } catch (err) {
    res.status(500).send(`Failed to connect QuickBooks: ${(err as Error).message}`);
  }
});

// --- Shopify webhook ----------------------------------------------------
import { verifyShopifyHmac } from "./lib/shopifyAuth";
import { claimWebhook } from "./lib/idempotency";
import { wakeWorkerMachine } from "./lib/flyMachines";
import { requireEnv } from "./lib/requireEnv";
import { pool } from "./db/pool";

interface ShopifyOrderPayload {
  id: number;
  [key: string]: unknown;
}

// express.raw() is scoped to this route only -- HMAC verification needs
// the exact bytes Shopify sent, so this must run before any express.json()
// elsewhere would parse/re-serialize the body.
app.post(
  "/webhooks/orders-create",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body as Buffer;
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const webhookId = req.get("X-Shopify-Webhook-Id");
    const topic = req.get("X-Shopify-Topic") ?? "orders/create";

    if (!verifyShopifyHmac(rawBody, hmacHeader, requireEnv("SHOPIFY_API_SECRET"))) {
      res.sendStatus(401);
      return;
    }

    if (!webhookId) {
      res.sendStatus(400);
      return;
    }

    // Atomic check-and-claim. If this webhook_id was already processed by
    // an earlier delivery attempt, ack and stop -- no further work needed.
    const claimed = await claimWebhook(pool, webhookId, topic);
    if (!claimed) {
      res.sendStatus(200);
      return;
    }

    let order: ShopifyOrderPayload;
    try {
      order = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.sendStatus(400);
      return;
    }

    // Insert BEFORE responding: acking 200 before this row is durably
    // persisted would create a window where a crash loses the order with
    // no trace, since Shopify won't retry a delivery it already got a 200
    // for. ON CONFLICT (shopify_order_id) DO NOTHING covers the case where
    // Shopify redelivers the same underlying event under a *different*
    // webhook_id (e.g. after a timeout) -- the idempotency claim above
    // only catches exact-same-delivery retries.
    const insertResult = await pool.query(
      `INSERT INTO order_sync_log (shopify_order_id, shopify_webhook_id, order_payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (shopify_order_id) DO NOTHING`,
      [order.id, webhookId, JSON.stringify(order)]
    );

    res.sendStatus(200);
    console.log(`web stored shopify order id :${order.id}`);

    // Wake the worker after acking, not before -- this call is best-effort
    // (see wakeWorkerMachine's own comment) and must never delay the
    // response Shopify is waiting on.
    if ((insertResult.rowCount ?? 0) > 0) {
      wakeWorkerMachine().catch((err) => {
        console.error("wakeWorkerMachine failed:", err);
      });
    }
  }
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`web listening on :${port}`);
});
