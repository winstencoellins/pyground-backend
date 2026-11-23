import { ApiError } from "../../lib/errors";
import type { MidtransStatus } from "./fulfill";

// Snap shows only these. QRIS is "other_qris"; "echannel" is Mandiri Bill.
export const ENABLED_PAYMENTS = [
  "other_qris",
  "gopay",
  "shopeepay",
  "bca_va",
  "bni_va",
  "bri_va",
  "permata_va",
  "cimb_va",
  "echannel",
  "other_va",
  "credit_card",
];

export function serverKey(): string {
  const key = process.env.MIDTRANS_SERVER_KEY;
  if (!key) throw new ApiError(503, "PAYMENTS_UNAVAILABLE", "Payments are not configured");
  return key;
}

function config() {
  const key = serverKey();
  const production = process.env.MIDTRANS_IS_PRODUCTION === "true";
  return {
    snapUrl: production
      ? "https://app.midtrans.com/snap/v1/transactions"
      : "https://app.sandbox.midtrans.com/snap/v1/transactions",
    apiUrl: production ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${btoa(`${key}:`)}`,
    },
  };
}

export type SnapRequest = {
  orderId: string;
  amount: number;
  item: { id: string; name: string };
  customer: { name: string; email: string };
  finishUrl: string;
};

/** Creates a Snap transaction. Throws 502 PAYMENT_PROVIDER_ERROR without leaking provider details. */
export async function createSnapTransaction(
  req: SnapRequest,
): Promise<{ token: string; redirectUrl: string }> {
  const { snapUrl, headers } = config();
  const res = await fetch(snapUrl, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      transaction_details: { order_id: req.orderId, gross_amount: req.amount },
      item_details: [
        { id: req.item.id, name: req.item.name.slice(0, 50), price: req.amount, quantity: 1 },
      ],
      customer_details: { first_name: req.customer.name.slice(0, 255), email: req.customer.email },
      enabled_payments: ENABLED_PAYMENTS,
      credit_card: { secure: true },
      callbacks: { finish: req.finishUrl },
    }),
  }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as {
    token?: string;
    redirect_url?: string;
    error_messages?: string[];
  } | null;
  if (!res?.ok || !body?.token || !body.redirect_url) {
    console.error(
      `[midtrans] snap ${res?.status ?? "network error"} for ${req.orderId}:`,
      body?.error_messages,
    );
    throw new ApiError(502, "PAYMENT_PROVIDER_ERROR", "Could not start the payment, try again");
  }
  return { token: body.token, redirectUrl: body.redirect_url };
}

/** Midtrans Get Status API (used by the webhook to confirm a notification, task #24). */
export async function getTransactionStatus(orderId: string): Promise<MidtransStatus> {
  const { apiUrl, headers } = config();
  const res = await fetch(`${apiUrl}/v2/${encodeURIComponent(orderId)}/status`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Midtrans status ${res.status} for ${orderId}`);
  return (await res.json()) as MidtransStatus;
}
