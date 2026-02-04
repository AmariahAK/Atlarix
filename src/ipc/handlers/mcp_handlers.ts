import { IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { db } from "../../db";
import { mcpServers, mcpToolConsents } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { createLoggedHandler } from "./safe_handle";

import { resolveConsent } from "../utils/mcp_consent";
import { getStoredConsent } from "../utils/mcp_consent";
import { mcpManager } from "../utils/mcp_manager";
import { CreateMcpServer, McpServerUpdate, McpTool } from "../ipc_types";
import { fetchUserBudget } from "./pro_handlers";

const logger = log.scope("mcp_handlers");
const handle = createLoggedHandler(logger);

const MCP_FREE_TIER_LIMIT = 1;
const MCP_GLOBAL_MAX = 5;
const MCP_WORKSPACE_MAX = 5;

type ConsentDecision = "accept-once" | "accept-always" | "decline";

export function registerMcpHandlers() {
  // List MCP servers (optional filter by scope / appId)
  handle(
    "mcp:list-servers",
    async (
      _event: IpcMainInvokeEvent,
      filter?: { scope?: "global" | "workspace"; appId?: number }
    ) => {
      if (!filter?.scope) {
        return await db.select().from(mcpServers);
      }
      if (filter.scope === "global") {
        return await db
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.scope, "global"));
      }
      if (filter.scope === "workspace" && filter.appId != null) {
        return await db
          .select()
          .from(mcpServers)
          .where(
            and(
              eq(mcpServers.scope, "workspace"),
              eq(mcpServers.appId, filter.appId)
            )
          );
      }
      return [];
    }
  );

  handle(
    "mcp:create-server",
    async (_event: IpcMainInvokeEvent, params: CreateMcpServer) => {
      const scope = params.scope ?? "global";
      const appId = params.appId ?? null;

      const budget = await fetchUserBudget();
      const isPro = budget != null && budget.totalCredits > 0;

      if (scope === "global") {
        const globalCount = await db
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.scope, "global"));
        if (globalCount.length >= MCP_GLOBAL_MAX) {
          throw new Error(
            `Maximum ${MCP_GLOBAL_MAX} global MCP servers. Remove one to add another.`
          );
        }
        if (!isPro && globalCount.length >= MCP_FREE_TIER_LIMIT) {
          throw new Error(
            "Free tier is limited to 1 MCP server. Upgrade to Pro for more."
          );
        }
      } else if (scope === "workspace" && appId != null) {
        const workspaceCount = await db
          .select()
          .from(mcpServers)
          .where(
            and(
              eq(mcpServers.scope, "workspace"),
              eq(mcpServers.appId, appId)
            )
          );
        if (workspaceCount.length >= MCP_WORKSPACE_MAX) {
          throw new Error(
            `Maximum ${MCP_WORKSPACE_MAX} MCP servers per workspace. Remove one to add another.`
          );
        }
      }

      const { name, transport, command, args, envJson, url, enabled } = params;
      const result = await db
        .insert(mcpServers)
        .values({
          name,
          transport,
          command: command || null,
          args: args || null,
          envJson: envJson || null,
          url: url || null,
          enabled: !!enabled,
          scope,
          appId,
        })
        .returning();
      return result[0];
    },
  );

  handle(
    "mcp:test-connection",
    async (_event: IpcMainInvokeEvent, serverId: number): Promise<{ ok: boolean; error?: string }> => {
      try {
        const client = await mcpManager.getClient(serverId);
        await client.tools();
        return { ok: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error("MCP test connection failed", e);
        return { ok: false, error: message };
      }
    },
  );

  handle(
    "mcp:update-server",
    async (_event: IpcMainInvokeEvent, params: McpServerUpdate) => {
      const update: any = {};
      if (params.name !== undefined) update.name = params.name;
      if (params.transport !== undefined) update.transport = params.transport;
      if (params.command !== undefined) update.command = params.command;
      if (params.args !== undefined) update.args = params.args || null;
      if (params.cwd !== undefined) update.cwd = params.cwd;
      if (params.envJson !== undefined) update.envJson = params.envJson || null;
      if (params.url !== undefined) update.url = params.url;
      if (params.enabled !== undefined) update.enabled = !!params.enabled;

      const result = await db
        .update(mcpServers)
        .set(update)
        .where(eq(mcpServers.id, params.id))
        .returning();
      // If server config changed, dispose cached client to be recreated on next use
      try {
        mcpManager.dispose(params.id);
      } catch {}
      return result[0];
    },
  );

  handle(
    "mcp:delete-server",
    async (_event: IpcMainInvokeEvent, id: number) => {
      try {
        mcpManager.dispose(id);
      } catch {}
      await db.delete(mcpServers).where(eq(mcpServers.id, id));
      return { success: true };
    },
  );

  // Tools listing (dynamic)
  handle(
    "mcp:list-tools",
    async (
      _event: IpcMainInvokeEvent,
      serverId: number,
    ): Promise<McpTool[]> => {
      try {
        // Avoid "HTTP MCP requires url" when server is HTTP but URL is not set
        const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).limit(1);
        if (server?.transport === "http" && !server?.url?.trim()) {
          logger.debug("mcp:list-tools skipped – HTTP server has no URL configured");
          return [];
        }
        const client = await mcpManager.getClient(serverId);
        const remoteTools = await client.tools();
        const tools = await Promise.all(
          Object.entries(remoteTools).map(async ([name, tool]) => ({
            name,
            description: tool.description ?? null,
            consent: await getStoredConsent(serverId, name),
          })),
        );
        return tools;
      } catch (e) {
        logger.error("Failed to list tools", e);
        return [];
      }
    },
  );
  // Consents
  handle("mcp:get-tool-consents", async () => {
    return await db.select().from(mcpToolConsents);
  });

  handle(
    "mcp:set-tool-consent",
    async (
      _event: IpcMainInvokeEvent,
      params: {
        serverId: number;
        toolName: string;
        consent: "ask" | "always" | "denied";
      },
    ) => {
      const existing = await db
        .select()
        .from(mcpToolConsents)
        .where(
          and(
            eq(mcpToolConsents.serverId, params.serverId),
            eq(mcpToolConsents.toolName, params.toolName),
          ),
        );
      if (existing.length > 0) {
        const result = await db
          .update(mcpToolConsents)
          .set({ consent: params.consent })
          .where(
            and(
              eq(mcpToolConsents.serverId, params.serverId),
              eq(mcpToolConsents.toolName, params.toolName),
            ),
          )
          .returning();
        return result[0];
      } else {
        const result = await db
          .insert(mcpToolConsents)
          .values({
            serverId: params.serverId,
            toolName: params.toolName,
            consent: params.consent,
          })
          .returning();
        return result[0];
      }
    },
  );

  // Tool consent request/response handshake
  // Receive consent response from renderer
  handle(
    "mcp:tool-consent-response",
    async (_event, data: { requestId: string; decision: ConsentDecision }) => {
      resolveConsent(data.requestId, data.decision);
    },
  );
}
