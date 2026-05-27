import type { QueryClient } from "@tanstack/react-query";
import type { McpServer, McpTool, McpToolConsent } from "@/ipc/ipc_types";

/** Drop a server from every MCP servers/tools react-query cache (all scopes). */
export function removeMcpServerFromAllCaches(
  queryClient: QueryClient,
  serverId: number,
): void {
  queryClient.setQueriesData<McpServer[]>(
    { queryKey: ["mcp", "servers"] },
    (old) => (old ?? []).filter((s) => s.id !== serverId),
  );
  queryClient.setQueriesData<Record<number, McpTool[]>>(
    { queryKey: ["mcp", "tools-by-server"] },
    (old) => {
      if (!old || !(serverId in old)) return old;
      const next = { ...old };
      delete next[serverId];
      return next;
    },
  );
  queryClient.setQueriesData<McpToolConsent[]>(
    { queryKey: ["mcp", "consents"] },
    (old) => (old ?? []).filter((c) => c.serverId !== serverId),
  );
}
