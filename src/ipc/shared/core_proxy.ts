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
