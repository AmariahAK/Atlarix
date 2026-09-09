import type { mcpServers } from "@/db/schema";
import { oauthConnectedFromRow } from "@/lib/mcp/oauth-token-utils";
import { decryptEnvFromDb } from "@/lib/security/db-secrets";

type McpServerRow = typeof mcpServers.$inferSelect;

export type SanitizedMcpServer = Omit<
  McpServerRow,
  "apiKey" | "oauthTokensJson" | "oauthClientJson" | "oauthDiscoveryJson"
> & {
  apiKey?: never;
  oauthTokensJson?: never;
  oauthClientJson?: never;
  oauthDiscoveryJson?: never;
  oauthConnected?: boolean;
};

/** Strip secrets before sending MCP server rows to the renderer. */
export function sanitizeMcpServerForIpc<
  T extends McpServerRow | null | undefined,
>(row: T): T extends McpServerRow ? SanitizedMcpServer : T {
  if (!row) return row as never;
  const {
    apiKey: _apiKey,
    oauthTokensJson: _tokens,
    oauthClientJson: _client,
    oauthDiscoveryJson: _discovery,
    ...rest
  } = row;
  return {
    ...rest,
    // Stored encrypted at rest — decrypt for the (trusted, context-isolated)
    // renderer so the config UI shows real env values for editing. Preserve
    // null so "no env" stays distinguishable from "empty env".
    envJson: row.envJson ? decryptEnvFromDb(row.envJson) : row.envJson,
    oauthConnected: oauthConnectedFromRow(row),
  } as never;
}

export function sanitizeMcpServersForIpc(
  rows: McpServerRow[],
): SanitizedMcpServer[] {
  return rows.map((r) => sanitizeMcpServerForIpc(r)!);
}
