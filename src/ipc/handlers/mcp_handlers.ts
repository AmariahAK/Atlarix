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
  addLocalServer,
  addPasted,
  addServerFromUrl,
  assertRoomForOneMore,
  installFromCatalog,
  limitMessage,
  mcpOnCount,
  MCP_ON_LIMIT,
  signInAccountServer,
} from "@/lib/mcp/mcp-add";
import {
  deleteConnector,
  listConnectorRows,
  setConnectorEnabled,
  setConnectorSecret,
} from "@/lib/mcp/account-connectors";
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

      // The limit is on servers that are ON (this folder's and the account's),
      // so a server added switched off never hits it.
      if (params.enabled) await assertRoomForOneMore(appId);
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
        headers,
        registryId,
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
          headersJson: encryptEnvForDb(headers ?? null),
          apiKey: apiKey?.trim() ? serializeApiKeyForDb(apiKey.trim()) : null,
          enabled: !!enabled,
          scope,
          appId,
          authType: resolvedAuthType,
          fromRegistry: !!registryId,
          registryId: registryId ?? null,
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
    // A public https server goes on the account like any other web server.
    if (s.transport === "http" && s.url) {
      return addServerFromUrl(
        appId,
        { url: s.url, name: s.name, headers: s.headers, ...(s.bearer ? { bearer: s.bearer } : {}) },
        { enable: true },
      );
    }
    return addLocalServer(
      appId,
      { name: s.name, transport: "stdio", command: s.command ?? null, args: s.args ?? null, env: s.env ?? null },
      { enable: true },
    );
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
      if (params.enabled === true) {
        const [current] = await db.select().from(mcpServers).where(eq(mcpServers.id, params.id));
        // Turning one ON is where the limit applies; turning one off, or
        // editing one that is already on, never hits it.
        if (current && !current.enabled) await assertRoomForOneMore(current.appId ?? null);
      }
      if (params.headers !== undefined) update.headersJson = encryptEnvForDb(params.headers);
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
        params.apiKey !== undefined ||
        params.envJson !== undefined ||
        params.headers !== undefined;

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

  // ─── Marketplace (official MCP Registry, cached) ──────────────────────────

  handle(
    "mcp-catalog:search",
    async (
      _event,
      params: { query?: string; offset?: number; limit?: number; appId?: number | null },
    ) => {
      const { searchMcpCatalog } = await import("@/lib/mcp/registry-catalog");
      const page = await searchMcpCatalog(params?.query ?? "", {
        offset: params?.offset,
        limit: params?.limit,
      });
      // Which of these are already added: this folder's own, or on the account.
      const installed = new Set<string>();
      if (params?.appId != null) {
        const rows = await db
          .select({ registryId: mcpServers.registryId })
          .from(mcpServers)
          .where(and(eq(mcpServers.scope, "workspace"), eq(mcpServers.appId, params.appId)));
        for (const r of rows) if (r.registryId) installed.add(r.registryId);
      }
      for (const c of (await listConnectorRows()) ?? []) {
        if (c.registryName) installed.add(c.registryName);
      }
      return { ...page, installed: page.entries.filter((e) => installed.has(e.name)).map((e) => e.name) };
    },
  );

  /** A logo as a checked data: URL, by registry name or by what a stored server knows. */
  handle(
    "mcp-catalog:icon",
    async (
      _event,
      params: { name?: string; registryName?: string | null; url?: string | null; command?: string | null; args?: string[] | null },
    ) => {
      const { getMcpIcon, getMcpIconFor } = await import("@/lib/mcp/mcp-icons");
      if (typeof params?.name === "string" && params.name) return getMcpIcon(params.name);
      return getMcpIconFor(params ?? {});
    },
  );

  /** A configured server's logo by the name the agent and the chat use. */
  handle("mcp:server-icon", async (_event, params: { appId?: number | null; name: string }) => {
    const { getMcpIconFor } = await import("@/lib/mcp/mcp-icons");
    const key = String(params?.name ?? "").toLowerCase();
    if (!key) return null;
    if (params.appId != null) {
      const rows = await db
        .select()
        .from(mcpServers)
        .where(and(eq(mcpServers.scope, "workspace"), eq(mcpServers.appId, params.appId)));
      const row = rows.find((r) => r.name.toLowerCase() === key);
      if (row) return getMcpIconFor({ registryName: row.registryId, url: row.url, command: row.command, args: row.args });
    }
    const c = ((await listConnectorRows()) ?? []).find((r) => r.name.toLowerCase() === key);
    return c ? getMcpIconFor({ registryName: c.registryName, url: c.url }) : null;
  });

  handle(
    "mcp-catalog:install",
    async (
      _event,
      params: { appId: number; name: string; optionId: string; values?: Record<string, string> },
    ) => {
      if (params?.appId == null) throw new Error("Open a folder before adding an MCP server.");
      return installFromCatalog(params.appId, {
        name: params.name,
        optionId: params.optionId,
        values: params.values ?? {},
      });
    },
  );

  /** "Add your own": a URL, a command, or a config block from another tool. */
  handle("mcp:add-pasted", async (_event, params: { appId: number; text: string; name?: string }) => {
    if (params?.appId == null) throw new Error("Open a folder before adding an MCP server.");
    return addPasted(params.appId, String(params.text ?? ""), params.name ? { name: params.name } : {});
  });

  /** The Verified five and where each stands here: on, off, needs the user, or not added. */
  handle("mcp:verified-status", async (_event, params: { appId?: number | null }) => {
    const { VERIFIED_MCP_SERVERS } = await import("@/shared/mcp-catalog");
    const { findMcpServer } = await import("@/lib/mcp/mcp-suggestions");
    return Promise.all(
      VERIFIED_MCP_SERVERS.map(async (v) => {
        const here = await findMcpServer(params?.appId ?? null, v.name).catch(() => null);
        return {
          name: v.name,
          title: v.fallback.title ?? v.name,
          state: !here ? "not-added" : here.needs ? `needs-${here.needs}` : here.enabled ? "on" : "off",
          ...(here ? { where: here.where, id: here.id } : {}),
        };
      }),
    );
  });

  /** How many are on, against the limit (this folder's plus the account's). */
  handle("mcp:limit", async (_event, params: { appId?: number | null }) => ({
    on: await mcpOnCount(params?.appId ?? null),
    max: MCP_ON_LIMIT,
  }));

  // ─── Suggestions: the agent asks the user to connect a server ────────────

  /** A chat's open suggestion cards, with the catalog entry and status for each. */
  handle("mcp-suggest:list", async (_event, params: { chatId?: number }) => {
    const { listMcpSuggestions } = await import("@/lib/mcp/mcp-suggestions");
    const { describeMcpSuggestion } = await import("@/lib/mcp/mcp-suggestions");
    return Promise.all(listMcpSuggestions(params?.chatId).map(describeMcpSuggestion));
  });

  /**
   * Connect the server a card is for: add it if it isn't here (a public https
   * one on the account), or switch it on. What still needs the user (a
   * browser sign-in, a key) comes back for the surface to finish, then
   * `mcp-suggest:finish`.
   */
  handle(
    "mcp-suggest:connect",
    async (_event, params: { id: string; optionId?: string; values?: Record<string, string> }) => {
      const { listMcpSuggestions, findMcpServer } = await import("@/lib/mcp/mcp-suggestions");
      const s = listMcpSuggestions().find((x) => x.id === params.id);
      if (!s) throw new Error("That suggestion is no longer open.");
      const here = await findMcpServer(s.appId, s.server);
      if (here) {
        if (!here.needs && !here.enabled) {
          if (here.where === "account") {
            const out = await setConnectorEnabled(String(here.id), true);
            if (!out.ok) throw new Error(out.error);
          } else {
            await assertRoomForOneMore(s.appId);
            await db.update(mcpServers).set({ enabled: true }).where(eq(mcpServers.id, Number(here.id)));
          }
        }
        return {
          where: here.where,
          id: here.id,
          name: here.name,
          enabled: true,
          needsSignIn: here.needs === "sign-in",
          ...(here.needs === "key" ? { needsSecret: { header: null } } : {}),
        };
      }
      if (s.appId == null) throw new Error("Open a folder before adding an MCP server.");
      const { getMcpCatalogEntry } = await import("@/lib/mcp/registry-catalog");
      const entry = await getMcpCatalogEntry(s.server);
      const option = params.optionId ?? entry?.options.find((o) => o.kind === "web" || o.supported)?.id;
      if (!entry || !option) throw new Error("That server can't be added from here.");
      return installFromCatalog(s.appId, { name: s.server, optionId: option, values: params.values ?? {} });
    },
  );

  /** The surface finished (signed in, saved a key): check it works and tell the agent. */
  handle("mcp-suggest:finish", async (_event, params: { id: string }) => {
    const { listMcpSuggestions, findMcpServer, resolveMcpSuggestion } = await import("@/lib/mcp/mcp-suggestions");
    const s = listMcpSuggestions().find((x) => x.id === params.id);
    if (!s) return { connected: false, reason: "That suggestion is no longer open." };
    const here = await findMcpServer(s.appId, s.server);
    if (!here) return { connected: false, reason: "It hasn't been added." };
    if (here.needs) return { connected: false, reason: here.needs === "sign-in" ? "It still needs a sign-in." : "It still needs its key." };
    // Added but OFF (the limit was full): not usable, so not "connected" — the
    // agent must not be told it is ready (QA).
    if (!here.enabled) return { connected: false, reason: limitMessage() };
    const tools = await toolNamesFor(here);
    resolveMcpSuggestion(s.id, { connected: true, server: here.name, where: here.where, tools });
    return { connected: true, server: here.name, tools };
  });

  handle("mcp-suggest:dismiss", async (_event, params: { id: string }) => {
    const { resolveMcpSuggestion } = await import("@/lib/mcp/mcp-suggestions");
    return resolveMcpSuggestion(params.id, { connected: false, reason: "the user said not now" });
  });

  // ─── Account servers (web, shared by every surface) ─────────────────────

  handle("connectors:list", async () => listConnectorRows());

  handle(
    "connectors:set-enabled",
    async (_event, params: { id: string; enabled: boolean; appId?: number | null }) => {
      if (params.enabled) {
        const rows = (await listConnectorRows()) ?? [];
        const row = rows.find((r) => r.id === params.id);
        if (row && !row.enabled && (await mcpOnCount(params.appId ?? null)) >= MCP_ON_LIMIT) {
          throw new Error(limitMessage());
        }
      }
      const out = await setConnectorEnabled(params.id, !!params.enabled);
      if (!out.ok) throw new Error(out.error);
      return true;
    },
  );

  handle("connectors:remove", async (_event, params: { id: string }) => {
    const out = await deleteConnector(params.id);
    if (!out.ok) throw new Error(out.error);
    return true;
  });

  handle(
    "connectors:set-secret",
    async (_event, params: { id: string; secret: string; appId?: number | null }) => {
      const out = await setConnectorSecret(params.id, String(params.secret ?? ""));
      if (!out.ok) throw new Error(out.error);
      // A key just made it usable: switch it on, room permitting.
      const row = (await listConnectorRows())?.find((r) => r.id === params.id);
      if (row && !row.enabled && params.secret && (await mcpOnCount(params.appId ?? null)) < MCP_ON_LIMIT) {
        await setConnectorEnabled(params.id, true);
      }
      return true;
    },
  );

  /** Browser sign-in for an account server; resolves when it lands (or gives up). */
  handle("connectors:sign-in", async (_event, params: { id: string; appId?: number | null }) =>
    signInAccountServer(params.id, params.appId ?? null),
  );

  handle("mcp:sandbox-diagnostics", async () => {
    return getMcpSandboxDiagnostics(readSettings());
  });
}

/** The tool names a connected server offers, for the agent's "it's ready" note. */
async function toolNamesFor(here: import("@/lib/mcp/mcp-suggestions").McpServerStatus): Promise<string[]> {
  try {
    if (here.where === "local") {
      const client = await mcpManager.getClient(Number(here.id));
      return Object.keys((await client.tools()) as Record<string, unknown>);
    }
    const { listAccountConnectors, clearAccountConnectorsCache } = await import("@/lib/mcp/account-connectors");
    clearAccountConnectorsCache();
    const c = (await listAccountConnectors()).find((x) => x.name === here.name);
    return (c?.tools ?? []).map((t) => t.name);
  } catch {
    return [];
  }
}
