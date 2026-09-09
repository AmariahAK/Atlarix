/**
 * Pass 7 — MCP marketplace registry.
 *
 * The MCP marketplace mirrors the Skills marketplace: instead of bundling a
 * list of pre-built MCPs in the app, Atlarix fetches a hosted `index.json`
 * from a public GitHub repo. The user can override the URL in settings if
 * they want to point at a private mirror.
 *
 * Source repo: https://github.com/AmariahAK/atlarix-mcps
 *
 * The official MCP reference servers (filesystem, github, postgres, slack,
 * brave-search, sentry, etc.) live at
 *   https://github.com/modelcontextprotocol/servers
 * — that repo is MIT licensed; the Atlarix registry just curates a subset
 * with install metadata.
 */

export const DEFAULT_MCP_REGISTRY_URL =
  "https://raw.githubusercontent.com/AmariahAK/atlarix-mcps/main/index.json";

export interface McpRegistryEnvVar {
  /** Environment variable name (e.g. `GITHUB_TOKEN`). */
  key: string;
  /** Human-readable label rendered in the install dialog. */
  label: string;
  /** Optional link the user can follow to provision the credential. */
  url?: string;
  /** When true the input is rendered as a password field. */
  secret?: boolean;
  /** Optional placeholder hint. */
  placeholder?: string;
}

export type McpRegistryAuthType = "none" | "env" | "oauth";

/**
 * Structured OAuth config for `authType: "oauth"` HTTP MCPs.
 *
 * The marketplace flow (interactive Connect → browser → loopback callback) is in
 * `src/lib/mcp/*`; most servers support OAuth metadata discovery + dynamic client
 * registration, so every field here is optional. Provide `clientId` only when the
 * server uses a pre-registered app, and `discoveryUrl`/`serverUrl` only when the
 * server's `.well-known` metadata isn't reachable from `url` directly.
 */
export interface McpRegistryOAuthConfig {
  /** Authorization server base URL (e.g. "https://slack.com/oauth"). */
  serverUrl?: string;
  /** Static client id, when the MCP uses a pre-registered app. Omit for dynamic registration (RFC 7591). */
  clientId?: string;
  /** OAuth scopes to request. Preferred location; falls back to top-level `oauthScopes`. */
  scopes?: string[];
  /** OAuth/OIDC metadata discovery URL (RFC 8414 / 9728). */
  discoveryUrl?: string;
  /** Whether the server supports dynamic client registration. Defaults to true. */
  supportsDynamicRegistration?: boolean;
}

export interface McpRegistryEntry {
  /** Stable identifier, mirrors the directory in the source repo. */
  id: string;
  name: string;
  description: string;
  /** Lucide icon name or a marketplace icon hint (e.g. "github", "slack"). */
  icon?: string;
  /** Link to the upstream MCP server implementation. */
  source: string;
  /**
   * Command Atlarix will run to launch the MCP. Most entries are
   * `npx @modelcontextprotocol/server-<name>`; can include extra args.
   * Not used when `authType === "oauth"` (remote HTTP server).
   */
  installUrl?: string;
  /** Remote HTTP MCP endpoint — required when `authType === "oauth"`. */
  url?: string;
  /**
   * Optional OAuth scopes for authorization request (HTTP OAuth MCPs).
   * @deprecated Prefer `oauth.scopes`. Kept for backward compatibility; read via `getMcpOAuthScopes`.
   */
  oauthScopes?: string[];
  /** Structured OAuth config (HTTP OAuth MCPs). Supersedes top-level `oauthScopes`. */
  oauth?: McpRegistryOAuthConfig;
  authType: McpRegistryAuthType;
  envVars: McpRegistryEnvVar[];
  tags?: string[];
  /** Curated marketplace category (e.g. "Developer tools", "Search"). Optional — UI degrades to tags. */
  category?: string;
  /** Approximate install count from the registry publisher. Optional badge. */
  installs?: number;
  /**
   * Visibility tier. IGNORED since 2026-09-08 — the app is free and the marketplace is
   * available on every plan, so nothing filters on this any more.
   *
   * The field stays in the type because the REMOTE index still carries it on 26 of its
   * 286 entries and `mcps:fetch-registry` is a bare cast with no runtime schema. Declaring
   * it documents what will arrive; deleting it would only make the extra key undeclared,
   * not absent.
   */
  tier?: string;
}

export interface McpRegistryIndex {
  /** Schema version of the registry payload. Always bump when fields change. */
  version: "1";
  mcps: McpRegistryEntry[];
}

/** Convert an `installUrl` like `npx @modelcontextprotocol/server-github` into
 *  the `{ command, args }` pair the stdio MCP transport expects. */
export function parseInstallUrl(installUrl: string): {
  command: string;
  args: string[];
} {
  const trimmed = installUrl.trim();
  if (!trimmed) return { command: "", args: [] };
  // Naive whitespace split is fine here — registry entries are curated and
  // never include shell metacharacters; the command runs through `child_process`'s
  // argv form so quoting is unnecessary.
  const parts = trimmed.split(/\s+/);
  const [command, ...args] = parts;
  return { command, args };
}

/** Resolve OAuth scopes for an entry, preferring the structured `oauth.scopes`. */
export function getMcpOAuthScopes(
  entry: McpRegistryEntry,
): string[] | undefined {
  return entry.oauth?.scopes ?? entry.oauthScopes;
}

/** Validate registry entry shape for OAuth HTTP MCPs. */
export function validateMcpRegistryEntry(
  entry: McpRegistryEntry,
): string | null {
  if (entry.authType === "oauth") {
    if (!entry.url?.trim()) {
      return "OAuth MCP registry entries require a url (HTTP endpoint).";
    }
    try {
      new URL(entry.url.trim());
    } catch {
      return "OAuth MCP registry entry url is not a valid URL.";
    }
  } else if (!entry.installUrl?.trim()) {
    return "MCP registry entries require installUrl unless authType is oauth.";
  }
  return null;
}
