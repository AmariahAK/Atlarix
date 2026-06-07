import { stripeRequest } from "./stripe-client";
import { findTransaction } from "./transactions";

export async function refundPayment(transactionId: string) {
  const txn = await findTransaction(transactionId);
  if (!txn) throw new Error("transaction not found");
  return stripeRequest("POST", "/refunds", { charge: txn.chargeId });
}
