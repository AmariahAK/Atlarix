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
 * NO PATH FORCE-MERGES MCP TOOLS ANY MORE, on any surface. This comment used to
 * say "chat-only mode still pre-loads global MCP tools for ergonomic discovery
 * (see chat_stream_handlers.ts)"; that path is gone — `chat_stream_handlers.ts`
 * has one unrelated mention of the word, and the only MCP entries in
 * `resolve-toolset.ts` are the three registry tools being DROPPED for surfaces
 * that cannot reach a server. The two-tool discovery contract above is the whole
 * story, and the browser extension copies it verbatim, so a reader who believed
 * the old sentence would look for a preload that does not exist on either side.
 */

import { isPluginMcpTag } from "@/lib/plugins/mcp-sync";
import log from "electron-log";
import { ToolRegistry } from "./registry";
import {
  callAccountConnector,
  listAccountConnectors,
  listConnectorRows,
} from "@/lib/mcp/account-connectors";
import { isPublicHttpsUrl } from "@/shared/mcp-catalog";
import {
  MCP_WORKSPACE_MAX,
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

/**
 * The list as the model reads it: every server and every tool NAME always fit.
 * Full tool descriptions did not — Notion (55 tools) plus Linear (68) went past
 * the tool-output budget, the cut list read as "truncated", and the agent went
 * searching the disk for its own configuration (QA). Descriptions are cut to a
 * line, and dropped altogether when the list would still be too long.
 */
const MCP_LIST_MAX_CHARS = 16_000;
export function compactListedServers(servers: ListedMcpServer[]): ListedMcpServer[] {
  const line = (d?: string) => {
    const first = (d ?? "").split(/\n|(?<=\.)\s/)[0]!.trim();
    return first.length > 90 ? `${first.slice(0, 89)}…` : first;
  };
  const short = servers.map((s) => ({
    ...s,
    tools: s.tools.map((t) => (line(t.description) ? { name: t.name, description: line(t.description) } : { name: t.name })),
  }));
  if (JSON.stringify(short).length <= MCP_LIST_MAX_CHARS) return short;
  return servers.map((s) => ({ ...s, tools: s.tools.map((t) => ({ name: t.name })) }));
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

/**
 * Servers the editor passed for this ACP session. They are the user's own
 * configuration, so they are ON like a folder's enabled servers, within the
 * same limit: past it they are named, not connected.
 */
async function listSessionMcps(sessionId: string | undefined): Promise<ListedMcpServer[]> {
  const { mcpManager } = await import("../../ipc/utils/mcp_manager");
  const list = mcpManager.listSessionServers(sessionId);
  if (list.length === 0) return [];
  const out: ListedMcpServer[] = [];
  for (const [i, { id, spec }] of list.entries()) {
    if (i >= MCP_WORKSPACE_MAX) {
      out.push({
        id,
        name: spec.name,
        scope: "editor",
        transport: spec.transport,
        tools: [],
        inactive: true,
        error: `More than ${MCP_WORKSPACE_MAX} servers: this one is not connected.`,
      });
      continue;
    }
    try {
      const client = await mcpManager.getClient(id);
      const toolSet = (await client.tools()) as Record<string, { description?: string }>;
      out.push({
        id,
        name: spec.name,
        scope: "editor",
        transport: spec.transport,
        tools: Object.entries(toolSet).map(([name, t]) => ({
          name,
          description: t?.description
            ? wrapUntrustedData(`mcp-tool:${spec.name}/${name}`, t.description)
            : t?.description,
        })),
      });
    } catch (err) {
      out.push({
        id,
        name: spec.name,
        scope: "editor",
        transport: spec.transport,
        tools: [],
        error: formatMcpError(err, spec.name).error,
      });
    }
  }
  return out;
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

  // Installed plugins' servers become this folder's rows (switched off until the
  // person turns one on) before the list is read.
  {
    const { syncPluginMcpServersForApp } = await import("@/lib/plugins/mcp-sync");
    await syncPluginMcpServersForApp(workspaceId);
  }

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
  handler: async (args: { workspaceId?: number; workspaceSessionId?: string }) => {
    try {
      // The editor's own servers for this session (ACP `mcpServers`) come
      // first: a folder or account server of the same name is dropped.
      const sessionServers = await listSessionMcps(args.workspaceSessionId);
      const editorNames = new Set(sessionServers.map((s) => s.name.toLowerCase()));
      const servers = [
        ...sessionServers,
        ...(await listConfiguredMcps(args.workspaceId ?? null)).filter(
          (s) => !editorNames.has(s.name.toLowerCase()),
        ),
      ];
      // Account connectors travel BESIDE the local ones, never merged into
      // them: a local server can be `stdio` with a command and an environment,
      // an account connector is HTTPS-only with its credential held by the
      // proxy, and forcing one shape onto the other makes every column
      // conditional. `scope` is what tells them apart.
      //
      // A LOCAL SERVER OF THE SAME NAME WINS, and the account one is dropped
      // rather than renamed. `mcp_call` resolves by name, so two entries
      // sharing one would make which server ran depend on list order — and
      // silently running the wrong one is far worse than not offering it.
      const local = new Set(servers.map((s) => s.name.toLowerCase()));
      for (const c of await listAccountConnectors()) {
        if (local.has(c.name.toLowerCase())) continue;
        servers.push({
          id: -1,
          name: c.name,
          description: c.description,
          scope: "account",
          transport: "http",
          tools: c.tools ?? [],
          ...(c.error ? { error: c.error } : {}),
          ...(c.needsOAuth ? { needsOAuth: true } : {}),
          ...(c.inactive ? { inactive: true } : {}),
        });
      }
      // Reported rather than only enforced: "you can't add another" would otherwise
      // look like a fault instead of a full workspace.
      // What is capped is how many are ON, not how many are added.
      const { mcpOnCount } = await import("@/lib/mcp/mcp-add");
      const on = await mcpOnCount(args.workspaceId ?? null).catch(() => 0);
      const limits = { on, max: MCP_WORKSPACE_MAX, canTurnOnMore: on < MCP_WORKSPACE_MAX };
      if (servers.length === 0) {
        return {
          servers: [],
          limits,
          message:
            "No MCP servers configured. Add one in Settings → MCP, attach a workspace that has workspace-scoped MCP servers, or add a connector on atlarix.dev/account — those are available in the app, the browser extension and the CLI. There is no tool here to add one.",
        };
      }
      return {
        servers: compactListedServers(servers),
        limits,
        usage:
          "Call mcp_call({ server: '<server name>', tool: '<tool name>', arguments: {...} }) to invoke a tool. Each invocation requires user consent on first use. " +
          "A service that isn't listed here: mcp_servers search finds it in the MCP Registry." +
          (limits.canTurnOnMore
            ? ""
            : ` ${limits.on} of ${limits.max} are on. Adding one is fine (it starts off); turn one off to turn another on.`),
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
    workspaceSessionId?: string;
    _chatSessionId?: number;
    _mcpInvocationContext?: McpInvocationContext;
  }) => {
    if (!args.server || !args.tool) {
      return {
        error:
          "mcp_call requires { server, tool }. Use list_available_mcps to discover both.",
      };
    }

    /**
     * ACCOUNT CONNECTORS ARE TRIED ONLY AFTER THE LOCAL ONES, in the same order
     * the listing shows them — a local server of the same name wins there, and
     * the two have to agree or `mcp_call` would run a different server from the
     * one the model was told about.
     *
     * It is checked here rather than merged into the query below because the
     * two live in different places: one is a row in SQLite, the other is a name
     * the proxy resolves. There is nothing to join.
     */
    const runAccountConnector = async () => {
      const connectors = await listAccountConnectors();
      const match = connectors.find(
        (c) => c.name.toLowerCase() === args.server!.toLowerCase(),
      );
      if (!match) return null;
      if (match.needsOAuth) {
        // The user can sign in from a card right here; the agent is told when they do.
        if (args._chatSessionId != null) {
          const { addMcpSuggestion } = await import("@/lib/mcp/mcp-suggestions");
          addMcpSuggestion({
            chatId: args._chatSessionId,
            appId: args.workspaceId ?? null,
            server: match.name,
            title: match.name,
            reason: "",
            wait: false,
          });
          const { waitingOnUserNote } = await import("@/lib/mcp/mcp-suggestions");
          return {
            error: `"${match.name}" is not signed in yet. ${waitingOnUserNote(match.name)}`,
            needsOAuth: true,
          };
        }
        return {
          error:
            `"${match.name}" is set up on your account but has not been authorised. ` +
            `Tell the user to open atlarix.dev/account, find it under Connectors, and ` +
            `click Connect — it cannot be authorised from here.`,
        };
      }
      const out = await callAccountConnector(
        match.name,
        args.tool!,
        (args.arguments ?? {}) as Record<string, unknown>,
      );
      // Added but never switched on by a person (the proxy will not turn it on
      // by itself): the same card, and the agent hears back when it's on.
      if (!out.ok && /never been turned on/i.test(out.error) && args._chatSessionId != null) {
        const { addMcpSuggestion, waitingOnUserNote } = await import("@/lib/mcp/mcp-suggestions");
        addMcpSuggestion({
          chatId: args._chatSessionId,
          appId: args.workspaceId ?? null,
          server: match.name,
          title: match.name,
          reason: "",
          wait: false,
        });
        return { error: `"${match.name}" is not switched on yet. ${waitingOnUserNote(match.name)}` };
      }
      return out.ok ? { result: out.result } : { error: out.error };
    };

    // The editor's own server for this session wins, as in the listing.
    const { mcpManager: manager } = await import("../../ipc/utils/mcp_manager");
    const fromEditor = manager
      .listSessionServers(args.workspaceSessionId)
      .slice(0, MCP_WORKSPACE_MAX)
      .find((x) => x.spec.name.toLowerCase() === args.server!.toLowerCase());

    // Per-workspace only — see listConfiguredMcps. Without a workspace there is
    // no LOCAL server to find, but an account connector is not per-workspace, so
    // this can no longer return early without looking.
    // A plugin's server exists only while its plugin verifies and is on for
    // this folder: sync first, so a removed or changed plugin's row is gone
    // before it can be started.
    if (args.workspaceId != null && !fromEditor) {
      const { syncPluginMcpServersForApp } = await import("@/lib/plugins/mcp-sync");
      await syncPluginMcpServersForApp(args.workspaceId);
    }
    if (args.workspaceId == null && !fromEditor) {
      const viaAccount = await runAccountConnector();
      if (viaAccount) return viaAccount;
      return {
        error:
          "MCP servers are configured per workspace, and no connector of that name " +
          "is set up on your account. Open a workspace folder to use a local one.",
      };
    }

    const [server] = fromEditor
      ? [{ id: fromEditor.id, name: fromEditor.spec.name, enabled: true }]
      : await db
          .select()
          .from(mcpServers)
          .where(
            and(
              eq(mcpServers.name, args.server),
              eq(mcpServers.scope, "workspace"),
              eq(mcpServers.appId, args.workspaceId!),
            ),
          )
          .limit(1);
    if (!server) {
      // Not local — it may still be a connector on the account, which is not
      // per-workspace. Only once BOTH have been looked in is "not configured"
      // an honest thing to say.
      const viaAccount = await runAccountConnector();
      if (viaAccount) return viaAccount;
      return {
        error: `MCP server "${args.server}" is not configured in this workspace, and no connector of that name is set up on your account. Call list_available_mcps to see what is.`,
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
     * THE CONSENT COMES FIRST. Until 2026-10-30 the server was enabled and its
     * process spawned by `getClient` before `requireConsent` ran, so an imported,
     * switched-off stdio config started its command with no card in front of it
     * (found by the plugins session's security review). Now the card is shown
     * before anything is switched on, and a run with nobody to ask (an
     * unattended automation) refuses instead of activating.
     */
    // A plugin's server never switches itself on here: the person turns it on
    // (plugins/mcp-sync.ts). Activating it would spawn the plugin's command
    // before any consent card.
    if (
      !server.enabled &&
      isPluginMcpTag((server as { registryId?: string | null }).registryId)
    ) {
      return {
        error: `MCP server "${args.server}" comes from a plugin and is off. Ask the user to turn it on in /mcp or Settings → MCP servers.`,
      };
    }
    const ctx = args._mcpInvocationContext;
    let consented = false;
    if (!server.enabled) {
      if (!ctx?.requireConsent) {
        return {
          error:
            `MCP server "${args.server}" is configured but not enabled, and this run has ` +
            `nobody to ask. Ask the user to enable it in Settings → MCP first.`,
        };
      }
      const ok = await ctx.requireConsent({
        serverId: server.id,
        serverName: server.name,
        toolName: args.tool!,
        toolDescription: `Switch on "${server.name}" and run ${args.tool}`,
        inputPreview: JSON.stringify(args.arguments ?? {}).slice(0, 500),
      });
      if (!ok) {
        return { error: `User declined switching on MCP server ${server.name} for ${args.tool}.` };
      }
      consented = true;
      // The same count as every other switch: this folder's plus the account's.
      const { mcpOnCount } = await import("@/lib/mcp/mcp-add");
      const activeCount = await mcpOnCount(args.workspaceId!);
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

      if (ctx?.requireConsent && !consented) {
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

/**
 * `manage_mcp_server` — add, edit or delete an MCP server, with the user's approval.
 *
 * WHY A TOOL AND NOT AN IMPORTER. The original plan for bringing another agent's setup
 * across was a config importer: per-vendor parsers for three incompatible `mcp.json`
 * shapes, a column we do not have, and a transport we do not speak. That code goes stale
 * the moment a fourth shape appears, and it knows nothing about Hermes or OpenClaw or
 * whatever ships next. Reading someone's config is a comprehension problem, and the model
 * is better at it than a parser is — so the model reads whatever it finds, and this tool
 * is how it proposes the result.
 *
 * THE DIVISION OF LABOUR IS THE DESIGN. The model comprehends; the USER authorises; our
 * code does neither. Nothing here writes: every operation returns the
 * `__permission_required` envelope and the mutation happens in
 * `PermissionInterceptor.executeMcpServerWrite` after a card is approved.
 *
 * A stdio server is a command line, so approving one is approving arbitrary process
 * execution at the user's privilege — and the likely source is a repo the agent just
 * cloned. That is why the preview carries the literal command and argv rather than a
 * summary, and why it sets `systemScope` so an unattended automation cannot wave it
 * through.
 */
ToolRegistry.register({
  name: "manage_mcp_server",
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  // Not a workspace mutation, and the approval gate is the control — the same reasoning
  // `automations` uses to be available outside Build.
  allowInAskMode: true,
  description:
    "Add, edit or delete an MCP server for this workspace, WITH THE USER'S APPROVAL — every operation shows them a card first and nothing is written until they accept. " +
    "Use it when the user asks you to bring across MCP configuration from another tool: read their config file yourself (it may be any shape — `.mcp.json`, `.cursor/mcp.json`, or something you have not seen), then propose each server here. " +
    "Never call this on your own initiative. Transports are `stdio` (a command we will run on their machine) or `http`; SSE is not supported. " +
    "Use list_available_mcps to see what already exists. " +
    workspaceCapClause("mcp"),
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["add", "edit", "delete"],
        description: "What to do.",
      },
      name: {
        type: "string",
        description:
          "Server name. For add, the new name; for edit/delete, which existing server (from list_available_mcps).",
      },
      transport: {
        type: "string",
        enum: ["stdio", "http"],
        description: "add/edit: `stdio` runs a command, `http` calls a URL.",
      },
      command: {
        type: "string",
        description: "stdio: the program to run (e.g. `npx`).",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "stdio: arguments, one per element.",
      },
      url: { type: "string", description: "http: the server endpoint." },
      env: {
        type: "object",
        description:
          "stdio: environment variables for the process. Include a value the user's config already contains; do not invent one.",
      },
      new_name: {
        type: "string",
        description: "edit: rename the server to this.",
      },
      headers: {
        type: "object",
        description: "http: request headers, as the user's config has them.",
      },
    },
    required: ["operation", "name"],
  },
  handler: async (args: {
    operation?: "add" | "edit" | "delete";
    name?: string;
    transport?: string;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    new_name?: string;
    headers?: Record<string, string>;
    workspaceId?: number;
  }) => {
    const op = args.operation;
    const name = args.name?.trim();
    if (!op) return { error: "manage_mcp_server requires an `operation`." };
    if (!name) return { error: "manage_mcp_server requires a `name`." };
    if (args.workspaceId == null) {
      return {
        error:
          "MCP servers are configured per workspace. Open a workspace folder first.",
      };
    }

    const [existing] = await db
      .select()
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.name, name),
          eq(mcpServers.scope, "workspace"),
          eq(mcpServers.appId, args.workspaceId),
        ),
      )
      .limit(1);

    // Not in this folder: it may be a web server on the account.
    const account = existing
      ? undefined
      : ((await listConnectorRows()) ?? []).find(
          (c) => c.name.toLowerCase() === name.toLowerCase(),
        );

    if (account && (op === "delete" || op === "edit")) {
      const newName = args.new_name?.trim();
      const changes: string[] = [];
      if (op === "edit") {
        if (newName && newName !== account.name) changes.push(`name: ${account.name} → ${newName}`);
        if (args.url && args.url !== account.url) changes.push(`url: ${account.url} → ${args.url}`);
        if (!changes.length) {
          return {
            success: true,
            message: `Nothing to change on "${account.name}" — the values given already match.`,
          };
        }
      }
      return {
        __permission_required: true,
        operation: "mcp_server_write",
        preview: {
          action: op,
          serverName: op === "edit" ? (newName ?? account.name) : account.name,
          systemScope: true,
          transport: "http" as const,
          url: args.url ?? account.url,
          scope: "account" as const,
          accountId: account.id,
          changes: changes.length ? changes : undefined,
          description:
            op === "delete"
              ? `Remove the MCP server "${account.name}" from your account.`
              : `Change MCP server "${account.name}" on your account.`,
          input: { accountId: account.id, name: newName, url: args.url },
        },
      };
    }

    if (op === "delete") {
      if (!existing) {
        return {
          error: `No MCP server named "${name}" in this workspace — it may already be gone. Call list_available_mcps.`,
        };
      }
      return {
        __permission_required: true,
        operation: "mcp_server_write",
        preview: {
          action: "delete" as const,
          serverName: existing.name,
          serverId: existing.id,
          systemScope: true,
          transport: existing.transport as "stdio" | "http",
          command: existing.command ?? undefined,
          args: existing.args ?? undefined,
          url: existing.url ?? undefined,
          description: `Remove the MCP server "${existing.name}" and its stored tool consents.`,
        },
      };
    }

    if (op === "add" && existing) {
      return {
        error: `An MCP server named "${name}" already exists here. Use operation:"edit" to change it.`,
      };
    }
    if (op === "edit" && !existing) {
      return {
        error: `No MCP server named "${name}" in this workspace. Call list_available_mcps to see what there is.`,
      };
    }

    const transport = (args.transport ?? existing?.transport) as
      | string
      | undefined;
    if (op === "add" && !transport) {
      return {
        error:
          'operation:"add" requires a `transport` — "stdio" (a command we run) or "http" (a URL).',
      };
    }
    if (transport && transport !== "stdio" && transport !== "http") {
      // Named explicitly rather than swallowed: SSE appears in other tools' configs, and
      // storing an unusable row would fail later at the moment of use, where the cause
      // is much harder to see.
      return {
        error: `Transport "${transport}" is not supported — Atlarix speaks "stdio" and "http" only. An SSE server cannot be added; tell the user rather than substituting another transport.`,
      };
    }

    const command = args.command ?? existing?.command ?? undefined;
    const argv = args.args ?? existing?.args ?? undefined;
    const url = args.url ?? existing?.url ?? undefined;
    if (transport === "stdio" && !command) {
      return { error: 'A "stdio" server requires a `command` to run.' };
    }
    if (transport === "http" && !url) {
      return { error: 'An "http" server requires a `url`.' };
    }

    const envKeys = Object.keys(args.env ?? {});
    const headerKeys = Object.keys(args.headers ?? {});
    // A public https server goes on the account (every surface). Decided again
    // when it is written, which falls back to this computer when signed out.
    const scope =
      op === "add" && transport === "http" && url && isPublicHttpsUrl(url)
        ? ("account" as const)
        : ("local" as const);
    const finalName = op === "edit" ? (args.new_name?.trim() ?? name) : name;

    const changes: string[] = [];
    if (op === "edit" && existing) {
      if (finalName !== existing.name)
        changes.push(`name: ${existing.name} → ${finalName}`);
      if (args.transport && args.transport !== existing.transport)
        changes.push(`transport: ${existing.transport} → ${args.transport}`);
      if (args.command && args.command !== existing.command)
        changes.push(`command: ${existing.command ?? "—"} → ${args.command}`);
      if (args.args) changes.push(`args → ${JSON.stringify(args.args)}`);
      if (args.url && args.url !== existing.url)
        changes.push(`url: ${existing.url ?? "—"} → ${args.url}`);
      if (envKeys.length) changes.push(`env: ${envKeys.join(", ")}`);
      if (headerKeys.length) changes.push(`headers: ${headerKeys.join(", ")}`);
      if (!changes.length) {
        // Saying so beats asking the user to approve nothing.
        return {
          success: true,
          message: `Nothing to change on "${existing.name}" — the values given already match.`,
        };
      }
    }

    return {
      __permission_required: true,
      operation: "mcp_server_write",
      preview: {
        action: op,
        serverName: finalName,
        serverId: existing?.id,
        systemScope: true,
        transport: transport as "stdio" | "http",
        command,
        args: argv ?? undefined,
        url,
        // KEYS ONLY on the card-facing field. The VALUES ride in `input` below,
        // because the executor writes the row after approval and has no other source
        // for them by then — but nothing renders `input`, so a secret never reaches
        // the screen. `manage-mcp-server-tool.test.ts` pins that confinement.
        envKeys: envKeys.length ? envKeys : undefined,
        headerKeys: headerKeys.length ? headerKeys : undefined,
        scope,
        changes: changes.length ? changes : undefined,
        description:
          op === "add"
            ? transport === "stdio"
              ? `Add MCP server "${finalName}" — Atlarix will run this program on your machine when its tools are used.`
              : `Add MCP server "${finalName}" at ${url}.`
            : `Change MCP server "${existing?.name}".`,
        input: {
          id: existing?.id,
          name: finalName,
          transport,
          command: transport === "stdio" ? command : null,
          args: transport === "stdio" ? (argv ?? null) : null,
          url: transport === "http" ? url : null,
          envJson: args.env ?? null,
          headers: transport === "http" ? (args.headers ?? null) : null,
          appId: args.workspaceId,
        },
      },
    };
  },
});
