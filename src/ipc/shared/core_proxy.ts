/**
 * Atlarix Core proxy endpoint (the `atlarix-proxy` service on Railway).
 *
 * This is the ONLY thing the client needs to talk to Core — and it is NOT a
 * secret (it's a public URL). The managed PROVIDER keys live on the proxy, not
 * in this bundle. Set at build time via Vite `define` (`ATLARIX_CORE_PROXY_URL`)
 * or a local shell var for dev.
 *
 * Returns undefined when unset — in that case the compass path falls back to a
 * LOCAL dev key (never present in a packaged release), so production builds
 * always route through the proxy.
 */
/**
 * The `X-Atlarix-Surface` value this build sends on every Core call.
 *
 * One subscription and one balance fund four surfaces — desktop, CLI,
 * extension, Reviewer — so the ledger has to record WHICH one spent, or the
 * account page collapses them into a single undifferentiated line. The header
 * is a label: the proxy validates it against an allowlist, and who is billed
 * comes from the verified JWT, never from this.
 *
 * **`app`, not `desktop`.** Every historical user-path row is already `app`,
 * and renaming would split one product across two rows on the account page and
 * need a backfill of the entire table for no gain.
 *
 * Lives here rather than at the call site so the CLI can import the same module
 * and send `cli` without re-deriving the contract. The extension has its own
 * copy for the same reason the rest of that package does: it cannot import
 * anything that reaches Node.
 */
export const ATLARIX_SURFACE = "app";

export function getCoreProxyBaseUrl(): string | undefined {
  const raw =
    typeof process !== "undefined" && process.env
      ? process.env.ATLARIX_CORE_PROXY_URL
      : undefined;
  const trimmed = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  if (!trimmed) return undefined;
  // The OpenRouter provider appends `/chat/completions` to baseURL, so the base
  // must end at the `/v1` root the proxy serves.
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
