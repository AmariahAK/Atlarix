import { stripeRequest } from "./stripe-client";
import { recordTransaction } from "./transactions";

export async function chargeCard(customerId: string, amountCents: number) {
  const charge = await stripeRequest("POST", "/charges", {
    customer: customerId,
    amount: amountCents,
  });
  await recordTransaction(customerId, amountCents, charge.id);
  return charge;
}
