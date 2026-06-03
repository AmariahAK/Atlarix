/** Placeholder for token-refresh-only transport; active OAuth uses per-flow loopback. */
export const MCP_OAUTH_RUNTIME_PLACEHOLDER_REDIRECT =
  "http://127.0.0.1/callback";

export type McpAuthType = "none" | "env" | "api_key" | "oauth";

export const MCP_OAUTH_FLOW_TIMEOUT_MS = 60_000;

/** How long the agent blocks waiting for the user to authenticate an MCP server. */
export const MCP_AUTH_WAIT_TIMEOUT_MS = 5 * 60_000;
