import { randomBytes } from "node:crypto";
import { shell } from "electron";
import log from "electron-log";
import { eq } from "drizzle-orm";
import { validateOpenExternalUrl } from "@/lib/external_url";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import {
  deserializeOAuthJsonFromDb,
  serializeOAuthJsonForDb,
  type StoredOAuthClient,
  type StoredOAuthDiscovery,
} from "./oauth-token-utils";
import {
  clearPendingMcpOAuthSession,
  getPendingMcpOAuthSession,
} from "./oauth-session-store";

export type McpOAuthRedirectHandler = (payload: {
  serverId: number;
  serverName: string;
  authorizationUrl: string;
}) => void;

/**
 * Thrown by a non-interactive provider when the SDK would otherwise open a
 * browser for interactive authorization. The runtime/agent path uses this to
 * fall back to a clean "needs sign-in" result instead of launching a dangling
 * OAuth window mid-turn (interactive auth only happens via startMcpOAuthFlow).
 */
export class McpInteractiveAuthRequiredError extends Error {
  constructor() {
    super("MCP server requires interactive sign-in");
    this.name = "McpInteractiveAuthRequiredError";
  }
}

let redirectHandler: McpOAuthRedirectHandler | undefined;

export function setMcpOAuthRedirectHandler(
  handler: McpOAuthRedirectHandler | undefined,
): void {
  redirectHandler = handler;
}

export class AtlarixOAuthProvider implements OAuthClientProvider {
  private readonly serverId: number;
  private readonly serverName: string;
  private readonly oauthState: string;
  private readonly redirectUri: string;
  /** When false, never open a browser — throw McpInteractiveAuthRequiredError instead. */
  private readonly interactive: boolean;

  constructor(
    serverId: number,
    serverName: string,
    redirectUrl: string,
    oauthState?: string,
    interactive = true,
  ) {
    this.serverId = serverId;
    this.serverName = serverName;
    this.redirectUri = redirectUrl;
    this.oauthState = oauthState ?? randomBytes(16).toString("hex");
    this.interactive = interactive;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Atlarix",
      redirect_uris: [String(this.redirectUrl)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.oauthState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = await db.query.mcpServers.findFirst({
      where: eq(mcpServers.id, this.serverId),
      columns: { oauthClientJson: true },
    });
    return deserializeOAuthJsonFromDb<StoredOAuthClient>(row?.oauthClientJson);
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await db
      .update(mcpServers)
      .set({ oauthClientJson: serializeOAuthJsonForDb(clientInformation) })
      .where(eq(mcpServers.id, this.serverId));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const row = await db.query.mcpServers.findFirst({
      where: eq(mcpServers.id, this.serverId),
      columns: { oauthTokensJson: true },
    });
    return deserializeOAuthJsonFromDb<OAuthTokens>(row?.oauthTokensJson);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const withMeta = {
      ...tokens,
      obtained_at: Math.floor(Date.now() / 1000),
    };
    await db
      .update(mcpServers)
      .set({ oauthTokensJson: serializeOAuthJsonForDb(withMeta) })
      .where(eq(mcpServers.id, this.serverId));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.interactive) {
      // Runtime/agent path: do not launch a browser mid-turn. The caller
      // converts this into a clean "needs sign-in" result; the user then
      // authorizes via the explicit Connect flow (startMcpOAuthFlow).
      throw new McpInteractiveAuthRequiredError();
    }
    const urlStr = authorizationUrl.toString();
    // H7 (security review): the authorization endpoint is server-supplied — a
    // malicious MCP server could return a file:// or custom-scheme URL. Validate
    // to http(s) before handing it to the OS (the gate every other openExternal
    // call site uses).
    try {
      validateOpenExternalUrl(urlStr);
    } catch (err) {
      log.error(
        `[mcp-oauth] refusing to open non-http authorization URL: ${urlStr}`,
        err,
      );
      throw new Error("MCP server returned an invalid authorization URL.");
    }
    redirectHandler?.({
      serverId: this.serverId,
      serverName: this.serverName,
      authorizationUrl: urlStr,
    });
    void shell.openExternal(urlStr);
  }

  saveCodeVerifier(codeVerifier: string): void {
    const pending = getPendingMcpOAuthSession(this.serverId);
    if (pending) pending.codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    const pending = getPendingMcpOAuthSession(this.serverId);
    if (!pending?.codeVerifier) {
      throw new Error("No OAuth code verifier for this MCP session");
    }
    return pending.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await db
      .update(mcpServers)
      .set({ oauthDiscoveryJson: serializeOAuthJsonForDb(state) })
      .where(eq(mcpServers.id, this.serverId));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const row = await db.query.mcpServers.findFirst({
      where: eq(mcpServers.id, this.serverId),
      columns: { oauthDiscoveryJson: true },
    });
    return deserializeOAuthJsonFromDb<StoredOAuthDiscovery>(
      row?.oauthDiscoveryJson,
    );
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier") {
      const pending = getPendingMcpOAuthSession(this.serverId);
      if (pending) pending.codeVerifier = undefined;
      return;
    }
    const patch: Partial<typeof mcpServers.$inferInsert> = {};
    if (scope === "all" || scope === "tokens") {
      patch.oauthTokensJson = null;
    }
    if (scope === "all" || scope === "client") {
      patch.oauthClientJson = null;
    }
    if (scope === "all" || scope === "discovery") {
      patch.oauthDiscoveryJson = null;
    }
    if (Object.keys(patch).length > 0) {
      await db
        .update(mcpServers)
        .set(patch)
        .where(eq(mcpServers.id, this.serverId));
    }
    if (scope === "all") {
      clearPendingMcpOAuthSession(this.serverId);
    }
  }
}
