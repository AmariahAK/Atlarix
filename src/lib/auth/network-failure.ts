/**
 * Detect transient network failures from fetch / Supabase client errors.
 */

export function isLikelyNetworkFailure(err: unknown): boolean {
  if (err == null) return false;
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  const name = String((err as Error)?.name ?? "");
  if (name === "TypeError" && msg.includes("fetch failed")) return true;
  if (msg.includes("fetch failed")) return true;
  if (msg.includes("network error")) return true;
  if (msg.includes("econnreset")) return true;
  if (msg.includes("econnrefused")) return true;
  if (msg.includes("enotfound")) return true;
  if (msg.includes("etimedout")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("und_err_connect")) return true;
  if (msg.includes("failed to fetch")) return true;
  const cause = (err as { cause?: { code?: string } })?.cause;
  if (
    cause?.code &&
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(
      cause.code,
    )
  ) {
    return true;
  }
  return false;
}
