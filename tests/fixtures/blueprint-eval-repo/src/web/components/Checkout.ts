import { chargeCard } from "../../api/payments/charge";
import { formatPrice } from "../format";

export async function submitCheckout(customerId: string, totalCents: number) {
  const charge = await chargeCard(customerId, totalCents);
  return "Charged " + formatPrice(totalCents) + " (" + charge.id + ")";
}
