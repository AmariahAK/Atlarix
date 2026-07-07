/** Placeholder for token-refresh-only transport; active OAuth uses per-flow loopback. */
export const MCP_OAUTH_RUNTIME_PLACEHOLDER_REDIRECT =
  "http://127.0.0.1/callback";

export type McpAuthType = "none" | "env" | "api_key" | "oauth";

// NOTE: the former MCP_OAUTH_FLOW_TIMEOUT_MS / MCP_AUTH_WAIT_TIMEOUT_MS were
// removed — every human-in-the-loop MCP auth wait now blocks INDEFINITELY
// (cancelled only by the turn's abort signal). See waitForMcpAuth / requireMcpAuth.
