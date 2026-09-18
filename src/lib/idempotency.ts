// Narrow interface so this is unit-testable against a fake without a real
// Pool/Client -- both pg's Pool and Client satisfy it.
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * Atomically claims a webhook delivery for processing. Returns true if this
 * call performed the insert (i.e. this is the first time we've seen this
 * webhook_id), false if it was already claimed by a prior delivery attempt.
 *
 * Deliberately a single INSERT ... ON CONFLICT DO NOTHING rather than a
 * SELECT-then-INSERT: the latter has a race window between two concurrent
 * deliveries of the same webhook_id.
 */
export async function claimWebhook(
  db: Queryable,
  webhookId: string,
  topic: string
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO processed_webhooks (webhook_id, topic)
     VALUES ($1, $2)
     ON CONFLICT (webhook_id) DO NOTHING`,
    [webhookId, topic]
  );
  return (result.rowCount ?? 0) > 0;
}
