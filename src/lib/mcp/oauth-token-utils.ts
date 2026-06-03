import log from "electron-log";
import {
  deserializeApiKeyFromDb,
  serializeApiKeyForDb,
} from "@/lib/security/db-secrets";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

const logger = log.scope("oauth-token-utils");

/** OAuth tokens persisted in DB with issuance timestamp for wall-clock expiry. */
export type StoredOAuthTokens = OAuthTokens & {
  obtained_at?: number;
};

const EXPIRY_SKEW_SECONDS = 60;

export function serializeOAuthJsonForDb(value: unknown): string {
  return serializeApiKeyForDb(JSON.stringify(value));
}

export function deserializeOAuthJsonFromDb<T>(
  stored: string | null | undefined,
  context?: string,
): T | undefined {
  if (stored?.trim() && context) {
    const plain = deserializeApiKeyFromDb(stored);
    if (!plain) {
      logger.warn(`Failed to decrypt OAuth JSON (${context})`);
      return undefined;
    }
    try {
      return JSON.parse(plain) as T;
    } catch {
      logger.warn(`Failed to parse OAuth JSON (${context})`);
      return undefined;
    }
  }
  const plain = deserializeApiKeyFromDb(stored);
  if (!plain) return undefined;
  try {
    return JSON.parse(plain) as T;
  } catch {
    return undefined;
  }
}

export function hasOAuthCredentials(
  tokens: StoredOAuthTokens | undefined,
): boolean {
  if (!tokens) return false;
  if (tokens.refresh_token?.trim()) return true;
  return Boolean(tokens.access_token?.trim());
}

export function isOAuthTokenValid(
  tokens: StoredOAuthTokens | undefined,
): boolean {
  if (!hasOAuthCredentials(tokens)) return false;
  if (tokens!.refresh_token?.trim()) return true;

  const expiresIn = tokens!.expires_in;
  if (expiresIn == null || !Number.isFinite(Number(expiresIn))) {
    return Boolean(tokens!.access_token?.trim());
  }

  const obtainedAt = tokens!.obtained_at;
  if (obtainedAt == null || !Number.isFinite(Number(obtainedAt))) {
    return Boolean(tokens!.access_token?.trim());
  }

  const expiresAt = Number(obtainedAt) + Number(expiresIn);
  return expiresAt > Math.floor(Date.now() / 1000) + EXPIRY_SKEW_SECONDS;
}

export function oauthConnectedFromRow(row: {
  authType?: string | null;
  oauthTokensJson?: string | null;
}): boolean {
  if (row.authType !== "oauth") return false;
  const tokens = deserializeOAuthJsonFromDb<StoredOAuthTokens>(
    row.oauthTokensJson,
    "oauth_tokens",
  );
  return isOAuthTokenValid(tokens);
}

export function resolveOAuthRedirectUrlFromRow(row: {
  oauthClientJson?: string | null;
  fallbackRedirectUrl: string;
}): string {
  const client = deserializeOAuthJsonFromDb<StoredOAuthClient>(
    row.oauthClientJson,
    "oauth_client",
  );
  const uri = client?.redirect_uris?.[0];
  if (typeof uri === "string" && uri.trim()) return uri.trim();
  return row.fallbackRedirectUrl;
}

export type StoredOAuthClient = OAuthClientInformationMixed & {
  redirect_uris?: string[];
};
export type StoredOAuthDiscovery = OAuthDiscoveryState;

export function shouldClearStaleOAuthClient(
  client: StoredOAuthClient | undefined,
  redirectUrl: string,
): boolean {
  if (!client) return false;
  const uris = client.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return true;
  return !uris.includes(redirectUrl);
}
