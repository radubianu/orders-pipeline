// Wakes the worker Machine via the Fly Machines API. Called by the web
// process right after acking a webhook -- the worker itself does the QBO
// sync, not this request path.
import { requireEnv } from "./requireEnv";

const FLY_MACHINES_API_BASE = "https://api.machines.dev/v1";

/**
 * Starts the worker Machine if it's stopped. Starting an already-running
 * Machine is a safe no-op per the Fly Machines API, so callers don't need
 * to check current state first.
 */
export async function wakeWorkerMachine(): Promise<void> {
  const app = requireEnv("FLY_APP_NAME");
  const machineId = requireEnv("FLY_WORKER_MACHINE_ID");
  const token = requireEnv("FLY_API_TOKEN");

  const res = await fetch(
    `${FLY_MACHINES_API_BASE}/apps/${app}/machines/${machineId}/start`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  // Fly returns 200 for "started" and also for "already running" -- both
  // are the safe-no-op case described above. Anything else is a real
  // failure, but we don't want it to fail the webhook response (the order
  // is already durably persisted in order_sync_log; the worker's own poll
  // loop will pick it up on its next cycle even if this wake call fails).
  if (!res.ok) {
    const text = await res.text();
    console.error(`failed to wake worker machine (${res.status}): ${text}`);
  }
}
