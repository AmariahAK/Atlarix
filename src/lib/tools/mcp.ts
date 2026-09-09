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

import log from "electron-log";
import { ToolRegistry } from "./registry";
import {
  MCP_WORKSPACE_MAX,
  describeWorkspaceCap,
  workspaceCapClause,
} from "@/lib/workspace-caps";
import { wrapUntrustedData } from "../streaming/untrusted-data";
import { db } from "../../db";
import { mcpServers } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import {
  McpNeedsAuthError,
  McpNeedsOAuthError,
} from "../../ipc/utils/mcp_manager";
import type { McpAuthType } from "../mcp/oauth-constants";

const logger = log.scope("mcp-tools");

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
  /** Configured but not switched on: named here, connected only on first use. */
  inactive?: boolean;
}

function formatMcpError(
  err: unknown,
  _serverName: string,
): { error: string; needsOAuth?: boolean; authRequired?: McpAuthRequired } {
  if (err instanceof McpNeedsAuthError) {
    const isOAuth = err instanceof McpNeedsOAuthError;
    const fix = isOAuth
      ? `Tell the user to open Settings → Tools & MCP and click Connect on "${err.serverName}" to authorize it, then call this tool again.`
      : `Tell the user to set the ${err.authType === "api_key" ? "API key" : "credentials"} for "${err.serverName}" in Settings → Tools & MCP, then call this tool again.`;
    return {
      error: `[MCP needs ${isOAuth ? "OAuth sign-in" : "authentication"}] "${err.serverName}" is not authenticated (${err.reason}). ${fix}`,
      ...(isOAuth ? { needsOAuth: true } : {}),
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

async function listConfiguredMcps(
  workspaceId: number | null | undefined,
): Promise<ListedMcpServer[]> {
  /**
   * MCP servers are per-workspace, full stop.
   *
   * This used to read `scope = 'global' OR (scope = 'workspace' AND appId = ?)`,
   * and with no workspace it read `scope = 'global'` ALONE. Global servers were
   * retired and their rows purged by migration 0049, and no code path can create
   * one — so that second branch was a query that could never match, and a
   * workspace-less caller got an empty list by accident rather than by design.
   * Returning early says the same thing on purpose, and saves a DB round trip.
   */
  if (workspaceId == null) return [];

  /**
   * EVERY configured server, enabled or not.
   *
   * This used to filter on `enabled`, which made a stored-but-inactive server
   * invisible — and a model cannot ask for what it cannot see. That mattered the
   * moment servers could arrive without being switched on: a config import lands
   * them `enabled: false` so nothing spawns unprompted, and they would have been
   * imported into a void.
   *
   * The active/inactive split is what the loop below acts on, not this query.
   */
  const servers = await db
    .select()
    .from(mcpServers)
    .where(
      and(eq(mcpServers.scope, "workspace"), eq(mcpServers.appId, workspaceId)),
    );
  const out: ListedMcpServer[] = [];

  const { mcpManager } = await import("../../ipc/utils/mcp_manager");
  for (const s of servers) {
    /**
     * An inactive server is NAMED, never connected.
     *
     * Listing its tools would mean spawning it — for a stdio server that is
     * launching someone's process, and for a remote one an authenticated round
     * trip — purely to render a menu. So it contributes a name and a description
     * and nothing else — the name and transport are all a stored row carries, since
     * there is no description column. That also keeps the list bounded as storage
     * grows: fifty stored servers cost fifty lines, not fifty connections.
     *
     * `mcp_call` is where it becomes real, through the consent and auth path that
     * already exists.
     */
    if (!s.enabled) {
      out.push({
        id: s.id,
        name: s.name,
        scope: s.scope,
        transport: s.transport,
        tools: [],
        inactive: true,
      });
      continue;
    }
    try {
      const client = await mcpManager.getClient(s.id);
      const toolSet = (await client.tools()) as Record<
        string,
        { description?: string }
      >;
      out.push({
        id: s.id,
        name: s.name,
        scope: s.scope,
        transport: s.transport,
        // H6 (security review): a remote tool DESCRIPTION is attacker-controllable
        // (tool-poisoning) — frame it as untrusted data so injected instructions in
        // a description aren't read as trusted docs. Tool RESULTS are already wrapped.
        tools: Object.entries(toolSet).map(([name, t]) => ({
          name,
          description: t?.description
            ? wrapUntrustedData(`mcp-tool:${s.name}/${name}`, t.description)
            : t?.description,
        })),
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
    "List MCP (Model Context Protocol) servers configured for this session: global servers plus, when in a workspace, that workspace's own MCP servers. Returns server names, transports, and the tool names each server exposes. Call this BEFORE invoking any MCP tool via mcp_call. " +
    workspaceCapClause("mcp"),
  parameters: { type: "object", properties: {} },
  handler: async (args: { workspaceId?: number }) => {
    try {
      const servers = await listConfiguredMcps(args.workspaceId ?? null);
      // Reported rather than only enforced: "you can't add another" would otherwise
      // look like a fault instead of a full workspace.
      const limits = describeWorkspaceCap("mcp", servers.length);
      if (servers.length === 0) {
        return {
          servers: [],
          limits,
          message:
            "No MCP servers configured. Add one in Settings → MCP, or attach a workspace that has workspace-scoped MCP servers.",
        };
      }
      return {
        servers,
        limits,
        usage:
          "Call mcp_call({ server: '<server name>', tool: '<tool name>', arguments: {...} }) to invoke a tool. Each invocation requires user consent on first use." +
          (limits.canAddMore
            ? ""
            : ` The workspace is at its limit of ${limits.max} MCP server(s). Remove one to add another — this is not a plan limit and there is no tier that raises it.`),
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
    "Invoke a specific MCP tool by server name and tool name. Use list_available_mcps first to discover which servers and tools are available — it also reports the plan limit on MCP servers and how many are in use. The user is prompted for consent on first use of each tool.",
  parameters: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server name (from list_available_mcps).",
      },
      tool: {
        type: "string",
        description: "Tool name within that server (from list_available_mcps).",
      },
      arguments: {
        type: "object",
        description:
          "Arguments object passed to the MCP tool (must match the tool's input schema).",
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
      return {
        error:
          "mcp_call requires { server, tool }. Use list_available_mcps to discover both.",
      };
    }

    // Per-workspace only — see listConfiguredMcps. Without a workspace there is
    // nothing to find, and saying so beats a lookup that cannot match followed
    // by a "not found" that implies the server might exist elsewhere.
    if (args.workspaceId == null) {
      return {
        error:
          "MCP servers are configured per workspace. Open a workspace folder to use one.",
      };
    }

    const [server] = await db
      .select()
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.name, args.server),
          eq(mcpServers.scope, "workspace"),
          eq(mcpServers.appId, args.workspaceId),
        ),
      )
      .limit(1);
    if (!server) {
      return {
        error: `MCP server "${args.server}" is not configured in this workspace. Call list_available_mcps to see what is.`,
      };
    }

    /**
     * FIRST USE ACTIVATES a configured-but-inactive server.
     *
     * `list_available_mcps` names inactive servers without connecting them, so this is
     * where one becomes real. Enabling here rather than refusing is the whole point of
     * storing them inactive: a user brings their config across, nothing spawns until
     * something actually needs it, and then it just works.
     *
     * The cap is enforced on ACTIVE servers, so activation has to respect it — and it
     * REFUSES rather than evicting. Auto-disabling somebody else's server to make room
     * silently rewrites a configuration the user set and could kill an in-flight
     * session; naming what to turn off leaves that decision where it belongs.
     *
     * This is not a security gate. Consent is: `requireConsent` still runs per tool on
     * first use, below, and that is what the user actually approves.
     */
    if (!server.enabled) {
      const activeCount = (
        await db
          .select()
          .from(mcpServers)
          .where(
            and(
              eq(mcpServers.enabled, true as any),
              eq(mcpServers.scope, "workspace"),
              eq(mcpServers.appId, args.workspaceId),
            ),
          )
      ).length;
      if (activeCount >= MCP_WORKSPACE_MAX) {
        return {
          error:
            `MCP server "${args.server}" is configured but not enabled, and this workspace ` +
            `already has the maximum ${MCP_WORKSPACE_MAX} enabled. Ask the user to disable ` +
            `one in Settings → MCP before using this server.`,
        };
      }
      await db
        .update(mcpServers)
        .set({ enabled: true as any })
        .where(eq(mcpServers.id, server.id));
      logger.log(
        `[mcp] activating "${server.name}" on first use (was configured but not enabled)`,
      );
    }

    const ctx = args._mcpInvocationContext;
    const { mcpManager } = await import("../../ipc/utils/mcp_manager");

    // Single invocation attempt (may throw McpNeedsAuthError before the call).
    const runCall = async (): Promise<Record<string, unknown>> => {
      const client = await mcpManager.getClient(server.id);
      const toolSet = (await client.tools()) as unknown as Record<
        string,
        {
          description?: string;
          execute?: (a: unknown, c?: unknown) => Promise<unknown>;
        }
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
          return {
            error: `User declined running MCP tool ${server.name}/${args.tool}.`,
          };
        }
      }

      const result = await tool.execute(args.arguments ?? {}, undefined);
      const resultStr =
        typeof result === "string" ? result : JSON.stringify(result);
      return {
        server: server.name,
        tool: args.tool,
        // External server output is untrusted — frame it as data, not instructions.
        result: wrapUntrustedData(`mcp:${server.name}`, resultStr),
      };
    };

    const toErrorResult = (err: unknown): Record<string, unknown> => {
      const formatted = formatMcpError(err, args.server ?? "MCP");
      return {
        error: formatted.error,
        ...(formatted.needsOAuth ? { needsOAuth: true } : {}),
        ...(formatted.authRequired
          ? { authRequired: formatted.authRequired }
          : {}),
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
