const STRIPE_BASE = "https://api.stripe.com/v1";

export async function stripeRequest(
  method: string,
  path: string,
  body: Record<string, unknown>,
) {
  const res = await fetch(STRIPE_BASE + path, {
    method,
    body: JSON.stringify(body),
  });
  return res.json();
}
