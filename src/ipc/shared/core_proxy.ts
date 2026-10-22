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
import { proxyFetch, setBuiltFallback } from "@/shared/proxy-failover";
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
export type AtlarixSurface = "app" | "cli" | "acp" | "vscode";

/**
 * Which Atlarix this process is, as REPORTED (the header above, analytics).
 *
 * An editor over ACP (Zed, JetBrains) and the VS Code panel run the CLI, and
 * were all reported as `cli`. They set `ATLARIX_REPORT_SURFACE` instead of
 * changing `ATLARIX_SURFACE`, which stays `cli`: database sharing, web search
 * and how links open all branch on that, and an editor must keep behaving as
 * the terminal it is. The proxy charges `acp`/`vscode` to the ledger as `cli`.
 *
 * Read per call, not at import: ACP learns its editor at `initialize`.
 * `typeof` guard: the renderer imports this module (via compass_constants) and
 * has no `process`.
 */
export function atlarixSurface(): AtlarixSurface {
  if (typeof process === "undefined") return "app";
  const reported = process.env?.ATLARIX_REPORT_SURFACE;
  if (reported === "acp" || reported === "vscode") return reported;
  return process.env?.ATLARIX_SURFACE === "cli" ? "cli" : "app";
}

/** The editor an ACP or VS Code-family process serves ("zed", "Cursor"), else "". */
export function atlarixEditor(): string {
  if (typeof process === "undefined") return "";
  return (process.env?.ATLARIX_ACP_EDITOR ?? "").trim().slice(0, 40);
}

/** `X-Atlarix-Surface`, and `X-Atlarix-Editor` when there is one, for a Core call. */
export function surfaceHeaders(): Record<string, string> {
  const editor = atlarixEditor();
  return {
    "X-Atlarix-Surface": atlarixSurface(),
    ...(editor ? { "X-Atlarix-Editor": editor } : {}),
  };
}

/**
 * `fetch` for a call to the Core proxy, with its fallback (item 10,
 * shared/proxy-failover.ts): the build's fallback URL, unless the hosted
 * core-models.json names another.
 */
export function coreProxyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const base = getCoreProxyBaseUrl();
  if (!base) return fetch(input, init);
  if (typeof process !== "undefined") setBuiltFallback(process.env?.ATLARIX_CORE_PROXY_FALLBACK_URL);
  return proxyFetch(base, input, init);
}

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

/**
 * A Core bearer token handed to a headless run, used INSTEAD of the Supabase
 * session.
 *
 * The cloud agent runs in the user's GitHub Actions with no Atlarix sign-in:
 * our server mints a run token scoped to one job (see `atlarix-proxy`
 * `resolveCaller`, iss `atlarix-cloud`) and the CLI reads it from
 * `--core-token-file`. It lives in memory only, never in `process.env`, so the
 * agent's own shell commands cannot inherit it.
 */
export { setPinnedCoreToken, getPinnedCoreToken } from "@/lib/core/pinned-token";
