export function formatPrice(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

export function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
