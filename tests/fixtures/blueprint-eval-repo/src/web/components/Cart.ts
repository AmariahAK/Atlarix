import { formatPrice } from "../format";

export function renderCart(items: Array<{ name: string; cents: number }>) {
  return items.map((i) => i.name + ": " + formatPrice(i.cents)).join("\n");
}
