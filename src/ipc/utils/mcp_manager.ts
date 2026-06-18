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
import { deserializeApiKeyFromDb, decryptEnvFromDb } from "@/lib/security/db-secrets";
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

class McpManager {
  private static _instance: McpManager;
  static get instance(): McpManager {
    if (!this._instance) this._instance = new McpManager();
    return this._instance;
  }

  private clients = new Map<number, MCPClient>();

  async getClient(serverId: number): Promise<MCPClient> {
    const existing = this.clients.get(serverId);
    if (existing) return existing;
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
      const envForTransport =
        Object.keys(env).length > 0 ? env : undefined;
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
        transport = new StreamableHTTPClientTransport(new URL(s.url as string), {
          authProvider: oauthProvider,
        });
      } else {
        const apiKey = deserializeApiKeyFromDb(s.apiKey)?.trim();
        transport = new StreamableHTTPClientTransport(new URL(s.url as string), {
          requestInit: apiKey
            ? { headers: { Authorization: `Bearer ${apiKey}` } }
            : undefined,
        });
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
    const c = this.clients.get(serverId);
    if (c) {
      c.close();
      this.clients.delete(serverId);
    }
  }
}

function isUnauthorizedMessage(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unauthorized|forbidden|401|403|oauth/i.test(error.message)
  );
}

export const mcpManager = McpManager.instance;
