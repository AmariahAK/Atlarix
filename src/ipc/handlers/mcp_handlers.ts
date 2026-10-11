import { IpcMainInvokeEvent } from "electron";
import { MCP_WORKSPACE_MAX } from "@/lib/workspace-caps";
import log from "electron-log";
import { db } from "../../db";
import { apps, mcpServers, mcpToolConsents } from "../../db/schema";
import { eq, and, or, isNull, notInArray } from "drizzle-orm";
import { createLoggedHandler } from "./safe_handle";

import { resolveConsent } from "../utils/mcp_consent";
import { getStoredConsent } from "../utils/mcp_consent";
import { mcpManager, McpNeedsOAuthError } from "../utils/mcp_manager";
import { notifyMcpAuthUpdated } from "@/lib/mcp/mcp-oauth-service";
import {
  CreateMcpServer,
  McpListToolsResult,
  McpServerUpdate,
} from "../ipc_types";
import {
  DEFAULT_MCP_REGISTRY_URL,
  parseInstallUrl,
  validateMcpRegistryEntry,
  type McpRegistryIndex,
} from "@/shared/mcp-registry";
import {
  serializeApiKeyForDb,
  encryptEnvForDb,
} from "@/lib/security/db-secrets";
import {
  sanitizeMcpServerForIpc,
  sanitizeMcpServersForIpc,
} from "@/lib/security/mcp-server-sanitize";
import { readSettings } from "@/main/settings";
import { getMcpSandboxDiagnostics } from "@/lib/mcp/firejail";

const logger = log.scope("mcp_handlers");
const handle = createLoggedHandler(logger);

/** Log MCP errors without full stack when the connection closed (expected after server exit / idle). */
export function logMcpError(context: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  const isConnectionClosed =
    /connection closed|Connection closed|MCPClientError/i.test(message) ||
    (e instanceof Error && e.name?.includes("MCP"));
  if (isConnectionClosed) {
    logger.warn(`${context}: ${message}`);
  } else {
    logger.error(context, e);
  }
}

/**
 * Re-exported from `lib/workspace-caps` so enforcement, the reported limit and the
 * sentence the model reads cannot drift apart. The old local literals are gone.
 */
export { MCP_WORKSPACE_MAX };

type ConsentDecision = "accept-once" | "accept-always" | "decline";

/**
 * How many MCP servers are ACTIVE in this workspace.
 *
 * The cap counts enabled servers, not stored rows. Storing a server costs a row; what a
 * workspace with fifty of them actually costs is comprehension and connections, and only
 * enabled ones are ever connected or listed to the model (`mcp.ts` filters on `enabled`
 * in both `list_available_mcps` and `mcp_call`).
 *
 * This is what lets a config import keep everything a user brought without any of it
 * going live: imported servers land `enabled: false` and sit outside the cap until the
 * user or the model turns one on. Note the column DEFAULTS TO TRUE (`schema.ts`), so an
 * inserter that forgets to set it lands the server active and inside the cap.
 */
async function activeWorkspaceMcpCount(appId: number): Promise<number> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.scope, "workspace"),
        eq(mcpServers.appId, appId),
        eq(mcpServers.enabled, true as any),
      ),
    );
  return rows.length;
}

export function registerMcpHandlers() {
  handle(
    "mcp:list-servers",
    async (
      _event: IpcMainInvokeEvent,
      filter?: { scope?: "workspace"; appId?: number },
    ) => {
      if (filter?.appId != null) {
        const rows = await db
          .select()
          .from(mcpServers)
          .where(
            and(
              eq(mcpServers.scope, "workspace"),
              eq(mcpServers.appId, filter.appId),
            ),
          );
        return sanitizeMcpServersForIpc(rows);
      }
      const rows = await db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.scope, "workspace"));
      return sanitizeMcpServersForIpc(rows);
    },
  );

  handle("mcp:list-orphaned-servers", async () => {
    const appRows = await db.select({ id: apps.id }).from(apps);
    const appIds = appRows
      .map((r) => r.id)
      .filter((id): id is number => typeof id === "number");
    if (appIds.length === 0) {
      const rows = await db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.scope, "workspace"));
      return sanitizeMcpServersForIpc(rows);
    }
    const rows = await db
      .select()
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.scope, "workspace"),
          or(isNull(mcpServers.appId), notInArray(mcpServers.appId, appIds)),
        ),
      );
    return sanitizeMcpServersForIpc(rows);
  });

  const createServer = async (params: CreateMcpServer) => {
      // Defense-in-depth behind the origin gate: reject a malformed payload
      // rather than trusting the compile-time type at runtime. (Kept lenient —
      // the transport config is a union; over-strict validation would break
      // existing saved servers.)
      if (
        params == null ||
        typeof params !== "object" ||
        typeof (params as { name?: unknown }).name !== "string" ||
        !(params as { name: string }).name.trim()
      ) {
        throw new Error("Invalid MCP server payload.");
      }
      const scope = "workspace";
      const appId = params.appId ?? null;
      if (appId == null) {
        throw new Error("Select a workspace before adding an MCP server.");
      }

      if ((await activeWorkspaceMcpCount(appId)) >= MCP_WORKSPACE_MAX) {
        throw new Error(
          `Maximum ${MCP_WORKSPACE_MAX} enabled MCP servers per workspace. Disable or remove one to add another.`,
        );
      }
      const {
        name,
        transport,
        command,
        args,
        envJson,
        url,
        apiKey,
        enabled,
        authType,
      } = params;
      const resolvedAuthType =
        authType ??
        (apiKey?.trim()
          ? "api_key"
          : envJson && Object.keys(envJson).length > 0
            ? "env"
            : "none");
      const result = await db
        .insert(mcpServers)
        .values({
          name,
          transport,
          command: command || null,
          args: args || null,
          envJson: encryptEnvForDb(envJson),
          url: url || null,
          apiKey: apiKey?.trim() ? serializeApiKeyForDb(apiKey.trim()) : null,
          enabled: !!enabled,
          scope,
          appId,
          authType: resolvedAuthType,
        })
        .returning();
      return sanitizeMcpServerForIpc(result[0]);
  };

  handle("mcp:create-server", async (_event: IpcMainInvokeEvent, params: CreateMcpServer) => createServer(params));

  /**
   * MCP servers set up in other tools on this computer (Claude Code, Cursor,
   * VS Code, Kiro, Windsurf, Zed, Claude Desktop), minus ones this folder
   * already has: offered with an Add button, never added on their own. No
   * environment or header values in the answer, only their names.
   */
  handle("mcp:discover-external", async (_event: IpcMainInvokeEvent, { appId }: { appId: number }) => {
    const { discoverExternalMcpServers } = await import("@/lib/mcp/discover-external");
    const app = appId ? await db.query.apps.findFirst({ where: eq(apps.id, appId) }) : null;
    const have = appId
      ? new Set((await db.select({ name: mcpServers.name }).from(mcpServers).where(and(eq(mcpServers.scope, "workspace"), eq(mcpServers.appId, appId)))).map((r) => r.name.toLowerCase()))
      : new Set<string>();
    return discoverExternalMcpServers(app?.path ?? null).filter((s) => !have.has(s.name.toLowerCase()));
  });

  /** Add one found server to this folder, its values read again from its file now. */
  handle("mcp:import-external", async (_event: IpcMainInvokeEvent, { appId, key }: { appId: number; key: string }) => {
    const { findExternalMcpServers } = await import("@/lib/mcp/discover-external");
    const app = appId ? await db.query.apps.findFirst({ where: eq(apps.id, appId) }) : null;
    const s = findExternalMcpServers(app?.path ?? null).find((x) => x.key === key);
    if (!s) throw new Error("That server isn't in its tool's settings any more.");
    return createServer({
      appId,
      name: s.name,
      transport: s.transport,
      command: s.command ?? null,
      args: s.args ?? null,
      envJson: s.env && Object.keys(s.env).length ? s.env : null,
      url: s.url ?? null,
      apiKey: s.bearer ?? null,
      enabled: true,
    } as CreateMcpServer);
  });

  handle(
    "mcp:test-connection",
    async (
      _event: IpcMainInvokeEvent,
      serverId: number,
    ): Promise<{ ok: boolean; error?: string; needsOAuth?: boolean }> => {
      try {
        mcpManager.dispose(serverId);
        const client = await mcpManager.getClient(serverId);
        await client.tools();
        return { ok: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logMcpError("MCP test connection failed", e);
        return {
          ok: false,
          error: message,
          needsOAuth: e instanceof McpNeedsOAuthError,
        };
      }
    },
  );

  handle(
    "mcp:update-server",
    async (_event: IpcMainInvokeEvent, params: McpServerUpdate) => {
      const update: Record<string, unknown> = {};
      if (params.name !== undefined) update.name = params.name;
      if (params.transport !== undefined) update.transport = params.transport;
      if (params.command !== undefined) update.command = params.command;
      if (params.args !== undefined) update.args = params.args || null;
      if (params.cwd !== undefined) update.cwd = params.cwd;
      if (params.envJson !== undefined)
        update.envJson = encryptEnvForDb(params.envJson);
      if (params.url !== undefined) update.url = params.url;
      if (params.apiKey !== undefined) {
        update.apiKey = params.apiKey?.trim()
          ? serializeApiKeyForDb(params.apiKey.trim())
          : null;
        mcpManager.dispose(params.id);
      }
      if (params.enabled !== undefined) update.enabled = !!params.enabled;

      const authChanged =
        params.apiKey !== undefined || params.envJson !== undefined;

      const result = await db
        .update(mcpServers)
        .set(update)
        .where(eq(mcpServers.id, params.id))
        .returning();
      try {
        mcpManager.dispose(params.id);
      } catch {}
      // Unblock any agent tool waiting on this server's credentials.
      if (authChanged) notifyMcpAuthUpdated(params.id);
      return sanitizeMcpServerForIpc(result[0]);
    },
  );

  handle(
    "mcp:delete-server",
    async (_event: IpcMainInvokeEvent, id: number) => {
      const serverId = Number(id);
      if (!Number.isFinite(serverId) || serverId <= 0) {
        throw new Error("Invalid MCP server id");
      }
      try {
        mcpManager.dispose(serverId);
      } catch {}

      const existing = await db
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .limit(1);
      if (existing.length === 0) {
        return { success: true, alreadyRemoved: true as const };
      }

      db.delete(mcpToolConsents)
        .where(eq(mcpToolConsents.serverId, serverId))
        .run();
      const removed = db
        .delete(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .returning({ id: mcpServers.id })
        .all();
      if (removed.length === 0) {
        throw new Error("Failed to delete MCP server");
      }
      return { success: true };
    },
  );

  handle(
    "mcp:list-tools",
    async (
      _event: IpcMainInvokeEvent,
      serverId: number,
    ): Promise<McpListToolsResult> => {
      try {
        const [server] = await db
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.id, serverId))
          .limit(1);
        if (server?.transport === "http" && !server?.url?.trim()) {
          logger.debug(
            "mcp:list-tools skipped – HTTP server has no URL configured",
          );
          return { tools: [], error: "HTTP MCP server has no URL configured" };
        }
        const client = await mcpManager.getClient(serverId);
        const remoteTools = await client.tools();
        const tools = await Promise.all(
          // The tuple used to be annotated `[string, { description?: string }]`.
          // v7's `Tool` is a wide union (executable / provider-defined / dynamic /
          // approval variants), and a hand-written stand-in no longer matches any
          // member. Inference reads `description` off the real type, so the
          // annotation was only ever a way to go stale.
          Object.entries(remoteTools).map(async ([name, tool]) => ({
            name,
            // v7 lets a tool's `description` be a FUNCTION of call context, not just
            // a string. This list is the consent UI — rendered with no call in
            // flight — so there is no context to resolve one against. Take the
            // string form when there is one and fall back to null, which the UI
            // already handles, rather than inventing a context to invoke it with.
            description:
              typeof tool.description === "string" ? tool.description : null,
            consent: await getStoredConsent(serverId, name),
          })),
        );
        return { tools };
      } catch (e) {
        logMcpError("Failed to list MCP tools (connection may have closed)", e);
        const message = e instanceof Error ? e.message : String(e);
        return {
          tools: [],
          error: message,
          needsOAuth: e instanceof McpNeedsOAuthError,
        };
      }
    },
  );

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
      }
      const result = await db
        .insert(mcpToolConsents)
        .values({
          serverId: params.serverId,
          toolName: params.toolName,
          consent: params.consent,
        })
        .returning();
      return result[0];
    },
  );

  handle(
    "mcp:tool-consent-response",
    async (_event, data: { requestId: string; decision: ConsentDecision }) => {
      resolveConsent(data.requestId, data.decision);
    },
  );

  handle(
    "mcps:fetch-registry",
    async (
      _event,
      params?: { url?: string },
    ): Promise<{
      success: boolean;
      registry?: McpRegistryIndex;
      error?: string;
    }> => {
      const url = params?.url || DEFAULT_MCP_REGISTRY_URL;
      try {
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Atlarix-MCP-Marketplace",
          },
        });
        if (!res.ok) {
          return {
            success: false,
            error: `Registry fetch failed: HTTP ${res.status}`,
          };
        }
        const json = (await res.json()) as McpRegistryIndex;
        if (!json || json.version !== "1" || !Array.isArray(json.mcps)) {
          return {
            success: false,
            error: "Registry payload is not a v1 index",
          };
        }
        return { success: true, registry: json };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error("[mcps:fetch-registry] error:", e);
        return { success: false, error: message };
      }
    },
  );

  handle(
    "mcps:install-from-registry",
    async (
      _event,
      params: {
        entry: McpRegistryIndex["mcps"][number];
        env: Record<string, string>;
        scope?: "global" | "workspace";
        appId?: number | null;
      },
    ): Promise<{
      success: boolean;
      serverId?: number;
      needsOAuth?: boolean;
      error?: string;
    }> => {
      try {
        const { entry, env, appId = null } = params;
        const scope = "workspace" as const;
        if (appId == null) {
          return {
            success: false,
            error: "Select a workspace before installing an MCP.",
          };
        }

        const entryError = validateMcpRegistryEntry(entry);
        if (entryError) {
          return { success: false, error: entryError };
        }

        if ((await activeWorkspaceMcpCount(appId)) >= MCP_WORKSPACE_MAX) {
          return {
            success: false,
            error: `Maximum ${MCP_WORKSPACE_MAX} enabled MCP servers per workspace. Disable or remove one to add another.`,
          };
        }
        if (entry.authType === "oauth") {
          const inserted = await db
            .insert(mcpServers)
            .values({
              name: entry.name,
              transport: "http",
              command: null,
              args: null,
              envJson: null,
              url: entry.url!.trim(),
              enabled: true,
              scope,
              appId,
              fromRegistry: true,
              registryId: entry.id,
              authType: "oauth",
            })
            .returning();

          const created = inserted[0];
          if (!created) {
            return { success: false, error: "Insert returned no rows" };
          }
          return { success: true, serverId: created.id, needsOAuth: true };
        }

        const missing = (entry.envVars ?? [])
          .filter((v) => !env[v.key]?.trim())
          .map((v) => v.key);
        if (missing.length > 0) {
          return {
            success: false,
            error: `Missing required env vars: ${missing.join(", ")}`,
          };
        }

        const { command, args } = parseInstallUrl(entry.installUrl ?? "");
        if (!command) {
          return {
            success: false,
            error: "Registry entry has empty installUrl",
          };
        }

        const inserted = await db
          .insert(mcpServers)
          .values({
            name: entry.name,
            transport: "stdio",
            command,
            args,
            envJson: Object.keys(env).length > 0 ? env : null,
            url: null,
            enabled: true,
            scope,
            appId,
            fromRegistry: true,
            registryId: entry.id,
            authType: entry.authType === "env" ? "env" : "none",
          })
          .returning();

        const created = inserted[0];
        if (!created) {
          return { success: false, error: "Insert returned no rows" };
        }
        return { success: true, serverId: created.id };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error("[mcps:install-from-registry] error:", e);
        return { success: false, error: message };
      }
    },
  );

  handle("mcp:sandbox-diagnostics", async () => {
    return getMcpSandboxDiagnostics(readSettings());
  });
}
