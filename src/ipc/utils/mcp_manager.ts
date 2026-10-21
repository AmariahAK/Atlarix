import { db } from "../../db";
import { mcpServers } from "../../db/schema";
import {
  experimental_createMCPClient as createMCPClient,
  type experimental_MCPClient as MCPClient,
} from "@ai-sdk/mcp";
import { eq } from "drizzle-orm";
import {
  auth,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  AtlarixOAuthProvider,
  McpInteractiveAuthRequiredError,
} from "@/lib/mcp/atlarix-oauth-provider";
import {
  MCP_OAUTH_RUNTIME_PLACEHOLDER_REDIRECT,
  type McpAuthType,
} from "@/lib/mcp/oauth-constants";
import {
  deserializeOAuthJsonFromDb,
  hasOAuthCredentials,
  resolveOAuthRedirectUrlFromRow,
  type StoredOAuthTokens,
} from "@/lib/mcp/oauth-token-utils";
import {
  deserializeApiKeyFromDb,
  decryptEnvFromDb,
} from "@/lib/security/db-secrets";
import { readSettings } from "@/main/settings";
import { wrapStdioSpawnForFirejail } from "@/lib/mcp/firejail";

export type McpAuthFailureReason = "missing" | "invalid";

export class McpNeedsAuthError extends Error {
  readonly needsAuth = true as const;

  constructor(
    readonly serverId: number,
    readonly serverName: string,
    readonly authType: McpAuthType,
    readonly reason: McpAuthFailureReason = "missing",
  ) {
    super(McpNeedsAuthError.messageFor(serverName, authType));
    this.name = "McpNeedsAuthError";
  }

  static messageFor(serverName: string, authType: McpAuthType): string {
    if (authType === "oauth") {
      return `MCP server "${serverName}" requires sign-in. Open Settings → MCP to connect.`;
    }
    return `MCP server "${serverName}" is not authenticated. Add its API key / credentials in Settings → MCP.`;
  }
}

export class McpNeedsOAuthError extends McpNeedsAuthError {
  readonly needsOAuth = true as const;

  constructor(
    serverId: number,
    serverName: string,
    reason: McpAuthFailureReason = "missing",
  ) {
    super(serverId, serverName, "oauth", reason);
    this.name = "McpNeedsOAuthError";
  }
}

/**
 * A server an editor passed in an ACP `session/new` or `session/load`: the
 * user's own configuration in that editor, for that session only. Never
 * stored; it lives as long as the session.
 */
export type SessionMcpServer =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers: Record<string, string>;
    };

class McpManager {
  private static _instance: McpManager;
  static get instance(): McpManager {
    if (!this._instance) this._instance = new McpManager();
    return this._instance;
  }

  private clients = new Map<number, MCPClient>();

  /**
   * Session servers, by a NEGATIVE id (a stored server's id is positive), so
   * one map of clients and one `dispose` serve both.
   */
  private sessionServers = new Map<number, { sessionId: string; spec: SessionMcpServer }>();
  private nextSessionServerId = -1;

  /** Replace a session's editor-passed servers (closing the old ones' connections). */
  setSessionServers(sessionId: string, specs: SessionMcpServer[]): void {
    this.clearSessionServers(sessionId);
    for (const spec of specs) {
      this.sessionServers.set(this.nextSessionServerId--, { sessionId, spec });
    }
  }

  clearSessionServers(sessionId: string): void {
    for (const [id, v] of this.sessionServers) {
      if (v.sessionId !== sessionId) continue;
      this.dispose(id);
      this.sessionServers.delete(id);
    }
  }

  listSessionServers(sessionId: string | null | undefined): Array<{ id: number; spec: SessionMcpServer }> {
    if (!sessionId) return [];
    return [...this.sessionServers]
      .filter(([, v]) => v.sessionId === sessionId)
      .map(([id, v]) => ({ id, spec: v.spec }));
  }

  private async getSessionClient(serverId: number): Promise<MCPClient> {
    const entry = this.sessionServers.get(serverId);
    if (!entry) throw new Error(`MCP server not found: ${serverId}`);
    const { spec } = entry;
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (spec.transport === "stdio") {
      const wrapped = await wrapStdioSpawnForFirejail(spec.command, spec.args, readSettings());
      transport = new StdioClientTransport({
        command: wrapped.command,
        args: wrapped.args,
        env: Object.keys(spec.env).length > 0 ? spec.env : undefined,
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : undefined,
      });
    }
    try {
      const client = await createMCPClient({ transport });
      this.clients.set(serverId, client);
      return client;
    } catch (error) {
      if (error instanceof UnauthorizedError || isUnauthorizedMessage(error)) {
        // The editor's config is where its credentials live; nothing here can fix them.
        throw new Error(
          `MCP server "${spec.name}" refused the connection (not authorised). Its credentials come from your editor's MCP settings.`,
        );
      }
      throw error;
    }
  }

  /**
   * How each server's last connection went in this process: what the CLI's
   * /mcp shows instead of only the saved switch (a server that is on but can't
   * connect read "✓ on" there, 15.7.0 QA).
   */
  private lastConnect = new Map<number, { ok: true } | { ok: false; error: string }>();
  private probes = new Map<number, Promise<void>>();

  connectionStatus(serverId: number): { ok: true } | { ok: false; error: string } | undefined {
    return this.lastConnect.get(serverId);
  }

  /**
   * Connect and list tools once, unless this process already knows how the
   * server connects. Never disposes a working client (a running turn may hold it).
   */
  probe(serverId: number): Promise<void> {
    if (this.lastConnect.has(serverId)) return Promise.resolve();
    const running = this.probes.get(serverId);
    if (running) return running;
    const p = (async () => {
      try {
        const client = await this.getClient(serverId);
        await client.tools();
      } catch (error) {
        this.noteFailed(serverId, error);
      }
    })().finally(() => this.probes.delete(serverId));
    this.probes.set(serverId, p);
    return p;
  }

  /** A client that connected but then failed (listing its tools): closed, and remembered as failed. */
  noteFailed(serverId: number, error: unknown): void {
    this.dispose(serverId);
    this.lastConnect.set(serverId, { ok: false, error: connectError(error) });
  }

  async getClient(serverId: number): Promise<MCPClient> {
    const existing = this.clients.get(serverId);
    if (existing) return existing;
    try {
      const client = await this.connect(serverId);
      this.lastConnect.set(serverId, { ok: true });
      return client;
    } catch (error) {
      this.lastConnect.set(serverId, { ok: false, error: connectError(error) });
      throw error;
    }
  }

  private async connect(serverId: number): Promise<MCPClient> {
    if (serverId < 0) return this.getSessionClient(serverId);
    const server = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    const s = server.find((x) => x.id === serverId);
    if (!s) throw new Error(`MCP server not found: ${serverId}`);

    if (s.authType === "oauth") {
      const tokens = deserializeOAuthJsonFromDb<StoredOAuthTokens>(
        s.oauthTokensJson,
        `server:${serverId}:tokens`,
      );
      if (!hasOAuthCredentials(tokens)) {
        throw new McpNeedsOAuthError(serverId, s.name);
      }
    }

    // API-key servers with no configured key can't authenticate — surface a
    // clean "needs auth" so the agent can prompt the user (auth-and-retry).
    if (s.authType === "api_key") {
      const key = deserializeApiKeyFromDb(s.apiKey)?.trim();
      if (!key) {
        throw new McpNeedsAuthError(serverId, s.name, "api_key", "missing");
      }
    }

    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    let oauthProvider: AtlarixOAuthProvider | undefined;

    if (s.transport === "stdio") {
      const args = s.args ?? [];
      const apiKey = deserializeApiKeyFromDb(s.apiKey)?.trim();
      const env: Record<string, string> | undefined = {
        ...decryptEnvFromDb(s.envJson),
        ...(apiKey ? { MCP_API_KEY: apiKey } : {}),
      };
      const envForTransport = Object.keys(env).length > 0 ? env : undefined;
      if (!s.command) throw new Error("MCP server command is required");
      const spawn = await wrapStdioSpawnForFirejail(
        s.command,
        args,
        readSettings(),
      );
      transport = new StdioClientTransport({
        command: spawn.command,
        args: spawn.args,
        env: envForTransport,
      });
    } else if (s.transport === "http") {
      if (!s.url) throw new Error("HTTP MCP requires url");
      if (s.authType === "oauth") {
        const redirectUrl = resolveOAuthRedirectUrlFromRow({
          oauthClientJson: s.oauthClientJson,
          fallbackRedirectUrl: MCP_OAUTH_RUNTIME_PLACEHOLDER_REDIRECT,
        });
        // Non-interactive: the agent/runtime path must never open a browser
        // mid-turn. Silent refresh only; otherwise surface "needs sign-in" and
        // let the user authorize via the explicit Connect flow.
        oauthProvider = new AtlarixOAuthProvider(
          serverId,
          s.name,
          redirectUrl,
          undefined,
          false,
        );
        const extra = decryptEnvFromDb(s.headersJson);
        transport = new StreamableHTTPClientTransport(
          new URL(s.url as string),
          {
            authProvider: oauthProvider,
            ...(Object.keys(extra).length > 0 ? { requestInit: { headers: extra } } : {}),
          },
        );
      } else {
        const apiKey = deserializeApiKeyFromDb(s.apiKey)?.trim();
        // Saved headers first, then the key: an explicit API key is the
        // Authorization header this server was set up with.
        const headers: Record<string, string> = {
          ...decryptEnvFromDb(s.headersJson),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
        transport = new StreamableHTTPClientTransport(
          new URL(s.url as string),
          {
            requestInit:
              Object.keys(headers).length > 0 ? { headers } : undefined,
          },
        );
      }
    } else {
      throw new Error(`Unsupported MCP transport: ${s.transport}`);
    }

    try {
      const client = await createMCPClient({ transport });
      this.clients.set(serverId, client);
      return client;
    } catch (error) {
      // Non-interactive provider signalled that a browser sign-in would be
      // needed — report it as needs-OAuth rather than leaking the raw error.
      if (error instanceof McpInteractiveAuthRequiredError) {
        this.dispose(serverId);
        throw new McpNeedsOAuthError(serverId, s.name);
      }
      if (
        s.authType === "oauth" &&
        oauthProvider &&
        s.url &&
        (error instanceof UnauthorizedError || isUnauthorizedMessage(error))
      ) {
        this.dispose(serverId);
        try {
          const refreshed = await this.tryRefreshOAuthTokens(
            s.url,
            oauthProvider,
          );
          if (refreshed) {
            const retryTransport = new StreamableHTTPClientTransport(
              new URL(s.url as string),
              { authProvider: oauthProvider },
            );
            const client = await createMCPClient({ transport: retryTransport });
            this.clients.set(serverId, client);
            return client;
          }
        } catch {
          // fall through to McpNeedsOAuthError
        }
        throw new McpNeedsOAuthError(serverId, s.name);
      }
      // API-key / env servers that reject the request (401/403) → classify as a
      // needs-auth so the agent can prompt the user to fix the key (auth-and-retry).
      if (
        (s.authType === "api_key" || s.authType === "env") &&
        (error instanceof UnauthorizedError || isUnauthorizedMessage(error))
      ) {
        this.dispose(serverId);
        throw new McpNeedsAuthError(serverId, s.name, s.authType, "invalid");
      }
      throw error;
    }
  }

  private async tryRefreshOAuthTokens(
    serverUrl: string,
    provider: AtlarixOAuthProvider,
  ): Promise<boolean> {
    try {
      const result = await auth(provider, { serverUrl });
      return result === "AUTHORIZED";
    } catch {
      return false;
    }
  }

  dispose(serverId: number) {
    // Its config changed or it is being re-tested: the next look connects again.
    this.lastConnect.delete(serverId);
    const c = this.clients.get(serverId);
    if (c) {
      c.close();
      this.clients.delete(serverId);
    }
  }
}

function connectError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
}

function isUnauthorizedMessage(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unauthorized|forbidden|401|403|oauth/i.test(error.message)
  );
}

export const mcpManager = McpManager.instance;
