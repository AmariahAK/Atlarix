/**
 * Pass 7: MCP scoping rework — on-demand discovery and invocation.
 *
 * Previously, every workspace chat had ALL configured MCP tools force-merged
 * into the model's tool set. That bloated context and was the same anti-pattern
 * we removed for Blueprint and skills.
 *
 * Now the model uses two registry tools:
 *   - list_available_mcps — discover what MCP servers / tools are configured
 *   - mcp_call             — invoke a specific server's tool by name
 *
 * Chat-only mode still pre-loads global MCP tools for ergonomic discovery
 * (see chat_stream_handlers.ts).
 */

import { ToolRegistry } from "./registry";
import { db } from "../../db";
import { mcpServers } from "../../db/schema";
import { and, eq, or } from "drizzle-orm";
import {
  McpNeedsAuthError,
  McpNeedsOAuthError,
} from "../../ipc/utils/mcp_manager";
import type { McpAuthType } from "../mcp/oauth-constants";

export interface McpAuthRequired {
  serverId: number;
  serverName: string;
  authType: McpAuthType;
  reason: "missing" | "invalid";
}

/** Injected per-call by the agent stream so MCP tools can pause for user action. */
export interface McpInvocationContext {
  requireConsent?: (info: {
    serverId: number;
    serverName: string;
    toolName: string;
    toolDescription?: string;
    inputPreview: string;
  }) => Promise<boolean>;
  /** Prompt the user to authenticate the server, then resolve true once connected. */
  requireAuth?: (info: McpAuthRequired) => Promise<boolean>;
}

interface ListedMcpServer {
  id: number;
  name: string;
  description?: string;
  scope: string;
  transport: string;
  tools: Array<{ name: string; description?: string }>;
  error?: string;
  needsOAuth?: boolean;
}

function formatMcpError(
  err: unknown,
  _serverName: string,
): { error: string; needsOAuth?: boolean; authRequired?: McpAuthRequired } {
  if (err instanceof McpNeedsAuthError) {
    return {
      error: err.message,
      ...(err instanceof McpNeedsOAuthError ? { needsOAuth: true } : {}),
      authRequired: {
        serverId: err.serverId,
        serverName: err.serverName,
        authType: err.authType,
        reason: err.reason,
      },
    };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

async function listConfiguredMcps(workspaceId: number | null | undefined): Promise<ListedMcpServer[]> {
  const enabled = eq(mcpServers.enabled, true as any);
  const where =
    workspaceId != null
      ? and(
          enabled,
          or(eq(mcpServers.scope, "global"), and(eq(mcpServers.scope, "workspace"), eq(mcpServers.appId, workspaceId)))
        )
      : and(enabled, eq(mcpServers.scope, "global"));

  const servers = await db.select().from(mcpServers).where(where);
  const out: ListedMcpServer[] = [];

  const { mcpManager } = await import("../../ipc/utils/mcp_manager");
  for (const s of servers) {
    try {
      const client = await mcpManager.getClient(s.id);
      const toolSet = (await client.tools()) as Record<string, { description?: string }>;
      out.push({
        id: s.id,
        name: s.name,
        scope: s.scope,
        transport: s.transport,
        tools: Object.entries(toolSet).map(([name, t]) => ({ name, description: t?.description })),
      });
    } catch (err) {
      const formatted = formatMcpError(err, s.name);
      out.push({
        id: s.id,
        name: s.name,
        scope: s.scope,
        transport: s.transport,
        tools: [],
        error: formatted.error,
        ...(formatted.needsOAuth ? { needsOAuth: true } : {}),
      });
    }
  }
  return out;
}

ToolRegistry.register({
  name: "list_available_mcps",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  description:
    "List MCP (Model Context Protocol) servers configured for this session: global servers plus, when in a workspace, that workspace's own MCP servers. Returns server names, transports, and the tool names each server exposes. Call this BEFORE invoking any MCP tool via mcp_call.",
  parameters: { type: "object", properties: {} },
  handler: async (args: { workspaceId?: number }) => {
    try {
      const servers = await listConfiguredMcps(args.workspaceId ?? null);
      if (servers.length === 0) {
        return {
          servers: [],
          message:
            "No MCP servers configured. Add one in Settings → MCP, or attach a workspace that has workspace-scoped MCP servers.",
        };
      }
      return {
        servers,
        usage:
          "Call mcp_call({ server: '<server name>', tool: '<tool name>', arguments: {...} }) to invoke a tool. Each invocation requires user consent on first use.",
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});

ToolRegistry.register({
  name: "mcp_call",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: true,
  description:
    "Invoke a specific MCP tool by server name and tool name. Use list_available_mcps first to discover which servers and tools are available. The user is prompted for consent on first use of each tool.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "MCP server name (from list_available_mcps)." },
      tool: { type: "string", description: "Tool name within that server (from list_available_mcps)." },
      arguments: {
        type: "object",
        description: "Arguments object passed to the MCP tool (must match the tool's input schema).",
      },
    },
    required: ["server", "tool"],
  },
  handler: async (args: {
    server?: string;
    tool?: string;
    arguments?: any;
    workspaceId?: number;
    _mcpInvocationContext?: McpInvocationContext;
  }) => {
    if (!args.server || !args.tool) {
      return { error: "mcp_call requires { server, tool }. Use list_available_mcps to discover both." };
    }

    const enabled = eq(mcpServers.enabled, true as any);
    const where =
      args.workspaceId != null
        ? and(
            enabled,
            eq(mcpServers.name, args.server),
            or(
              eq(mcpServers.scope, "global"),
              and(eq(mcpServers.scope, "workspace"), eq(mcpServers.appId, args.workspaceId))
            )
          )
        : and(enabled, eq(mcpServers.scope, "global"), eq(mcpServers.name, args.server));

    const [server] = await db.select().from(mcpServers).where(where).limit(1);
    if (!server) {
      return {
        error: `MCP server "${args.server}" not found or not enabled. Call list_available_mcps to see what is configured.`,
      };
    }

    const ctx = args._mcpInvocationContext;
    const { mcpManager } = await import("../../ipc/utils/mcp_manager");

    // Single invocation attempt (may throw McpNeedsAuthError before the call).
    const runCall = async (): Promise<Record<string, unknown>> => {
      const client = await mcpManager.getClient(server.id);
      const toolSet = (await client.tools()) as unknown as Record<
        string,
        { description?: string; execute?: (a: unknown, c?: unknown) => Promise<unknown> }
      >;
      const tool = toolSet[args.tool!];
      if (!tool || typeof tool.execute !== "function") {
        return {
          error: `Tool "${args.tool}" not found on MCP server "${args.server}". Available tools: ${Object.keys(toolSet).join(", ") || "(none)"}.`,
        };
      }

      if (ctx?.requireConsent) {
        const ok = await ctx.requireConsent({
          serverId: server.id,
          serverName: server.name,
          toolName: args.tool!,
          toolDescription: tool.description,
          inputPreview: JSON.stringify(args.arguments ?? {}).slice(0, 500),
        });
        if (!ok) {
          return { error: `User declined running MCP tool ${server.name}/${args.tool}.` };
        }
      }

      const result = await tool.execute(args.arguments ?? {}, undefined);
      return {
        server: server.name,
        tool: args.tool,
        result: typeof result === "string" ? result : JSON.stringify(result),
      };
    };

    const toErrorResult = (err: unknown): Record<string, unknown> => {
      const formatted = formatMcpError(err, args.server ?? "MCP");
      return {
        error: formatted.error,
        ...(formatted.needsOAuth ? { needsOAuth: true } : {}),
        ...(formatted.authRequired ? { authRequired: formatted.authRequired } : {}),
      };
    };

    try {
      return await runCall();
    } catch (err) {
      // Auth-and-retry: if the server isn't authenticated, prompt the user to
      // connect/configure, wait, then retry the call once.
      if (err instanceof McpNeedsAuthError && ctx?.requireAuth) {
        let authed = false;
        try {
          authed = await ctx.requireAuth({
            serverId: err.serverId,
            serverName: err.serverName,
            authType: err.authType,
            reason: err.reason,
          });
        } catch {
          authed = false;
        }
        if (authed) {
          try {
            mcpManager.dispose(server.id);
            return await runCall();
          } catch (retryErr) {
            return toErrorResult(retryErr);
          }
        }
      }
      return toErrorResult(err);
    }
  },
});
