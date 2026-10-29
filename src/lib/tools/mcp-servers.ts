/**
 * `mcp_servers` — find MCP servers and manage their connections.
 *
 * search: the official MCP Registry (Atlarix's synced copy), with what each
 *   server needs to connect and whether it is already here.
 * suggest: put a card in front of the user to connect one. The user decides;
 *   nothing is added without their click. With `wait` the tool returns their
 *   answer; otherwise a connection arrives later, like a finished background
 *   command (lib/mcp/mcp-suggestions.ts).
 * start / stop: switch a configured server on or off (within the limit).
 * disconnect: sign a server out, so the user reconnects it from a card.
 * defaults: the servers every workspace offers in the composer's menu
 *   (lib/mcp/default-servers.ts); with `servers`, replaces them.
 *
 * Adding, editing and deleting servers stays with `manage_mcp_server` and its
 * approval card.
 */
import { isPluginMcpTag } from "@/lib/plugins/mcp-sync";
import { ToolRegistry } from "./registry";

interface SuggestContext {
  unattended?: boolean;
  signal?: AbortSignal;
}

type Args = {
  operation?: "search" | "suggest" | "start" | "stop" | "disconnect" | "defaults";
  query?: string;
  servers?: string[];
  server?: string;
  reason?: string;
  wait?: boolean;
  workspaceId?: number;
  _chatSessionId?: number;
  _mcpSuggestContext?: SuggestContext;
};

/** What connecting a catalog entry takes, in a few words. */
function needsFor(entry: import("@/shared/mcp-catalog").CatalogEntry): string {
  const option = entry.options.find((o) => o.kind === "web" || o.supported);
  if (!option) return "cannot be installed by Atlarix";
  const asks = option.inputs.filter((i) => i.required).map((i) => i.label);
  if (option.kind === "web") {
    return asks.length ? `on the web; asks for ${asks.join(", ")}` : "on the web; sign-in, if any, happens when connecting";
  }
  return `runs on this computer (${option.registryType})${asks.length ? `; asks for ${asks.join(", ")}` : ""}`;
}

ToolRegistry.register({
  name: "mcp_servers",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: true,
  description:
    "Find and connect the MCP server for a service the user asks about that isn't connected; turn added ones on or off. " +
    "`search` (query): servers in the official MCP Registry matching it, with what each needs to connect and whether it is already added. " +
    "`suggest` (server, reason): shows the user a card to connect a server; with `wait: true` it returns when they connect or decline, otherwise you are told when they connect. " +
    "`start` / `stop` (server): turn an added server on or off. " +
    "`disconnect` (server): sign it out; the user reconnects it from a card. " +
    "`defaults` (servers?): the servers every workspace offers the user; with `servers` (registry names), replaces them.",
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["search", "suggest", "start", "stop", "disconnect", "defaults"] },
      query: { type: "string" },
      servers: { type: "array", items: { type: "string" } },
      server: { type: "string", description: "A registry name from search, or an added server's name." },
      reason: { type: "string", description: "suggest: one line shown on the card." },
      wait: { type: "boolean" },
    },
    required: ["operation"],
  },
  handler: async (args: Args) => {
    const op = args.operation;
    const appId = args.workspaceId ?? null;

    if (op === "search") {
      const query = args.query?.trim() ?? "";
      const { searchMcpCatalog } = await import("@/lib/mcp/registry-catalog");
      const page = await searchMcpCatalog(query, { limit: 10 });
      const { findMcpServer } = await import("@/lib/mcp/mcp-suggestions");
      const servers = await Promise.all(
        page.entries.map(async (e) => {
          const here = await findMcpServer(appId, e.name);
          return {
            server: e.name,
            title: e.title,
            publisher: e.verified ? "Verified" : e.publisher,
            description: e.description,
            needs: needsFor(e),
            ...(here
              ? { added: here.where, on: here.enabled, ...(here.needs ? { missing: here.needs } : {}) }
              : {}),
          };
        }),
      );
      return { total: page.total, servers };
    }

    if (op === "defaults") {
      const { defaultMcpServersStatus, setDefaultMcpServers } = await import("@/lib/mcp/default-servers");
      if (args.servers) {
        const out = await setDefaultMcpServers(args.servers);
        if (!out.ok) return { error: out.error };
      }
      const servers = await defaultMcpServersStatus(appId);
      return { defaults: servers.map((s) => ({ server: s.name, title: s.title, state: s.state })) };
    }

    const name = args.server?.trim();
    if (!name) return { error: `mcp_servers ${op ?? ""} requires \`server\`.`.trim() };
    const { findMcpServer } = await import("@/lib/mcp/mcp-suggestions");

    if (op === "suggest") {
      const ctx = args._mcpSuggestContext;
      if (ctx?.unattended) {
        return { error: "Nobody is here to connect a server during an unattended run." };
      }
      if (args._chatSessionId == null) return { error: "Suggestions need a chat." };
      const here = await findMcpServer(appId, name);
      if (here?.enabled && !here.needs) {
        return { connected: true, server: here.name, message: `"${here.name}" is already connected and on.` };
      }
      let title = here?.name ?? name;
      if (!here) {
        const { getMcpCatalogEntry } = await import("@/lib/mcp/registry-catalog");
        const entry = await getMcpCatalogEntry(name);
        if (!entry) {
          return { error: `No server "${name}" in the registry or here. Use operation "search" to find one.` };
        }
        if (!entry.installable) return { error: `"${entry.title}" cannot be installed by Atlarix.` };
        title = entry.title;
      }
      const { addMcpSuggestion, waitForMcpSuggestion } = await import("@/lib/mcp/mcp-suggestions");
      const s = addMcpSuggestion({
        chatId: args._chatSessionId,
        appId,
        server: here?.registryName ?? (here ? here.name : name),
        title,
        reason: (args.reason ?? "").trim().slice(0, 300),
        wait: !!args.wait,
      });
      if (!args.wait) {
        const { waitingOnUserNote } = await import("@/lib/mcp/mcp-suggestions");
        return { shown: true, server: title, message: waitingOnUserNote(title) };
      }
      const outcome = await waitForMcpSuggestion(s.id, ctx?.signal);
      return outcome.connected
        ? { connected: true, server: outcome.server, where: outcome.where, tools: outcome.tools ?? [] }
        : { connected: false, server: title, message: `Not connected: ${outcome.reason}.` };
    }

    if (op === "start" || op === "stop" || op === "disconnect") {
      const here = await findMcpServer(appId, name);
      if (!here) return { error: `No MCP server named "${name}" is added here. Call list_available_mcps.` };
      const on = op === "start";
      if (op === "disconnect") {
        // Nothing to sign out of (no sign-in, no key): disconnecting it means
        // switching it off, and saying so — "signed out" was wrong (QA #10).
        const hasCredential = here.authType === "oauth" || here.authType === "api_key" || here.authType === "header";
        if (here.where === "account") {
          const { setConnectorSecret, setConnectorEnabled } = await import("@/lib/mcp/account-connectors");
          // An empty credential is the proxy's "clear" signal.
          const out = hasCredential ? await setConnectorSecret(String(here.id), "") : await setConnectorEnabled(String(here.id), false);
          if (!out.ok) return { error: out.error };
        } else {
          const { db } = await import("@/db");
          const { mcpServers } = await import("@/db/schema");
          const { eq } = await import("drizzle-orm");
          if (here.authType === "oauth") {
            const { revokeMcpOAuth } = await import("@/lib/mcp/mcp-oauth-service");
            await revokeMcpOAuth(Number(here.id));
          } else if (here.authType === "api_key") {
            await db.update(mcpServers).set({ apiKey: null }).where(eq(mcpServers.id, Number(here.id)));
          } else {
            await db.update(mcpServers).set({ enabled: false }).where(eq(mcpServers.id, Number(here.id)));
          }
          const { mcpManager } = await import("@/ipc/utils/mcp_manager");
          mcpManager.dispose(Number(here.id));
        }
        // Signed out: the card to sign back in comes up at once (owner: "disconnect
        // so the user can reconnect via popup"); QA found none came back.
        if (hasCredential && args._chatSessionId != null) {
          const { addMcpSuggestion } = await import("@/lib/mcp/mcp-suggestions");
          addMcpSuggestion({
            chatId: args._chatSessionId,
            appId,
            server: here.registryName ?? here.name,
            title: here.name,
            reason: "",
            wait: false,
          });
        }
        return {
          disconnected: true,
          server: here.name,
          message: hasCredential
            ? `"${here.name}" is signed out. The user has a card to sign back in.`
            : `"${here.name}" has nothing to sign out of, so it is switched off. Start it to use it again.`,
        };
      }
      if (here.enabled === on) return { server: here.name, on, message: `"${here.name}" is already ${on ? "on" : "off"}.` };
      // A plugin's server is turned on by the person, never by the agent: it runs
      // a command from a plugin (plugins/mcp-sync.ts).
      if (on && here.where !== "account" && isPluginMcpTag(here.registryName)) {
        return { error: `"${here.name}" comes from a plugin. The user turns it on in /mcp or Settings → MCP servers.` };
      }
      if (on && here.needs) {
        return { error: `"${here.name}" needs ${here.needs === "sign-in" ? "a sign-in" : "its key"} first. Suggest it so the user can connect it.` };
      }
      if (on) {
        const { mcpOnCount, MCP_ON_LIMIT } = await import("@/lib/mcp/mcp-add");
        if ((await mcpOnCount(appId)) >= MCP_ON_LIMIT) {
          return { error: `${MCP_ON_LIMIT} MCP servers are already on. Stop one first.` };
        }
      }
      if (here.where === "account") {
        const { setConnectorEnabled } = await import("@/lib/mcp/account-connectors");
        const out = await setConnectorEnabled(String(here.id), on);
        if (!out.ok) return { error: out.error };
      } else {
        const { db } = await import("@/db");
        const { mcpServers } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(mcpServers).set({ enabled: on }).where(eq(mcpServers.id, Number(here.id)));
        if (!on) {
          const { mcpManager } = await import("@/ipc/utils/mcp_manager");
          mcpManager.dispose(Number(here.id));
        }
      }
      const { broadcastToAllWindows } = await import("@/ipc/utils/broadcast_all_windows");
      broadcastToAllWindows("mcp:servers-changed", { appId });
      return { server: here.name, on };
    }

    return { error: "operation must be one of search, suggest, start, stop, disconnect, defaults." };
  },
});
