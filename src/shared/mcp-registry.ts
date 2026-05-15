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

export type McpRegistryAuthType = "none" | "env";
export type McpRegistryTier = "free" | "workforce";

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
   */
  installUrl: string;
  authType: McpRegistryAuthType;
  envVars: McpRegistryEnvVar[];
  tags?: string[];
  /** Visibility — `"workforce"` entries are hidden for free/pro users. */
  tier?: McpRegistryTier;
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
