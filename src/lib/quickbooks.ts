import { getValidAccessToken } from "./qboOAuth";

function apiBase(): string {
  const env = process.env.QBO_ENVIRONMENT ?? "sandbox";
  return env === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

export interface QboLineInput {
  qboItemId: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface CreateSalesReceiptResult {
  qboDocId: string;
}

/**
 * Creates a QBO SalesReceipt with one SalesItemLineDetail line per input
 * line. Callers are responsible for having already decomposed bundles and
 * mapped each SKU to a qbo_item_id (see bundleDecomposition.ts and
 * sku_qbo_item_map) -- this function just does the API call.
 */
export async function createSalesReceipt(
  lines: QboLineInput[],
  txnDate: string
): Promise<CreateSalesReceiptResult> {
  if (lines.length === 0) {
    throw new Error("cannot create a sales receipt with zero lines");
  }

  const { realmId, accessToken } = await getValidAccessToken();

  const payload = {
    // Without this, QBO defaults TxnDate to the moment the API call runs,
    // not the moment the order was placed -- those can differ by days if
    // the worker retried, or was woken up late.
    TxnDate: txnDate,
    Line: lines.map((line) => ({
      DetailType: "SalesItemLineDetail",
      Amount: line.amount,
      SalesItemLineDetail: {
        ItemRef: { value: line.qboItemId },
        Qty: line.quantity,
        UnitPrice: line.unitPrice,
      },
    })),
  };

  const res = await fetch(`${apiBase()}/v3/company/${realmId}/salesreceipt`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO salesreceipt request failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { SalesReceipt: { Id: string } };
  return { qboDocId: json.SalesReceipt.Id };
}
