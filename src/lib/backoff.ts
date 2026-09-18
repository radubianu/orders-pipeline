// Exponential backoff schedule for order_sync_log retries: 1min, 5min,
// 30min, then holds at 30min for any further attempt before max_retries
// caps it. Indexes are 1-based retry_count values.
const BACKOFF_MINUTES = [1, 5, 30];

export function backoffMs(retryCount: number): number {
  const index = Math.min(
    Math.max(retryCount - 1, 0),
    BACKOFF_MINUTES.length - 1
  );
  // index is clamped into [0, BACKOFF_MINUTES.length - 1] above.
  return BACKOFF_MINUTES[index]! * 60 * 1000;
}
