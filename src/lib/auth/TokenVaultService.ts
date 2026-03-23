/**
 * Token Vault Service — v4.0 Workforce
 * =====================================
 * Auth0-powered agent authentication. Agents request tokens at runtime;
 * Auth0 Token Exchange (RFC 8693) for external service tokens.
 * When Auth0 is unavailable (offline/misconfigured), falls back to existing
 * credential store and notifies via callback (toast).
 */

import log from 'electron-log';

const logger = log.scope('token-vault');

const AUTH0_TOKEN_EXCHANGE_GRANT =
  'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token';
const SUBJECT_TOKEN_TYPE_REFRESH = 'urn:ietf:params:oauth:token-type:refresh_token';
const REQUESTED_TOKEN_TYPE = 'http://auth0.com/oauth/token-type/federated-connection-access-token';

/** Map Atlarix service names to Auth0 connection names (configure in Auth0 dashboard) */
const SERVICE_TO_CONNECTION: Record<string, string> = {
  slack: 'slack',
  jira: 'jira',
  linear: 'linear',
  google: 'google-oauth2',
  google_calendar: 'google-oauth2',
  github: 'github',
  sentry: 'sentry',
  gitlab: 'gitlab',
  bitbucket: 'bitbucket',
};

export interface ConnectedService {
  name: string;
  scopes: string[];
  connectedAt: string;
  expiresAt: string | null;
}

let vaultUnavailableReason: string | null = null;
let onFallbackWarning: ((message: string) => void) | null = null;

/** Stored Auth0 tokens (set via storeAuth0Tokens from OAuth callback) */
let storedRefreshToken: string | null = null;
let storedAccessToken: string | null = null;
let storedAccessTokenExpiry = 0;

/**
 * Store Auth0 tokens after user completes Auth0 login / connect flow.
 * Called from main process when handling atlarix://auth0/callback or similar.
 */
export function storeAuth0Tokens(refreshToken: string, accessToken: string, expiresInSeconds: number): void {
  storedRefreshToken = refreshToken;
  storedAccessToken = accessToken;
  storedAccessTokenExpiry = Date.now() + expiresInSeconds * 1000;
  logger.log('[TokenVault] Auth0 tokens stored');
}

/**
 * Register callback for fallback warning (e.g. show toast in renderer)
 */
export function setTokenVaultFallbackWarning(cb: (message: string) => void): void {
  onFallbackWarning = cb;
}

let fallbackCaptured = false;
function warnFallback(): void {
  const msg = 'Auth0 Token Vault unavailable — using stored credentials';
  if (vaultUnavailableReason) logger.warn('[TokenVault]', vaultUnavailableReason);
  onFallbackWarning?.(msg);
  if (!fallbackCaptured) {
    fallbackCaptured = true;
    import('../../main/lib/analytics').then(({ capture }) => {
      capture('token_vault_fallback', { reason: vaultUnavailableReason ? 'error' : 'unconfigured' });
    }).catch(() => {});
  }
}

function isConfigured(): boolean {
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET;
  const vaultId = process.env.AUTH0_TOKEN_VAULT_ID;
  const audience = process.env.AUTH0_AUDIENCE;
  if (!domain || !clientId || !clientSecret || !vaultId || !audience) {
    vaultUnavailableReason = 'Missing AUTH0_* env vars (see .env.example and SECRETS.md)';
    return false;
  }
  vaultUnavailableReason = null;
  return true;
}

function getDomain(): string {
  const d = process.env.AUTH0_DOMAIN ?? '';
  return d.startsWith('http') ? d : `https://${d}`;
}

/**
 * Exchange Auth0 refresh token for Auth0 access token (for My Account API etc.)
 */
async function getAuth0AccessToken(): Promise<string | null> {
  if (!isConfigured() || !storedRefreshToken) return null;
  if (storedAccessToken && Date.now() < storedAccessTokenExpiry - 60_000) {
    return storedAccessToken;
  }
  const domain = getDomain();
  const url = `${domain}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.AUTH0_CLIENT_ID!,
    client_secret: process.env.AUTH0_CLIENT_SECRET!,
    refresh_token: storedRefreshToken,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!res.ok || !data.access_token) {
      logger.warn('[TokenVault] refresh failed:', data);
      return null;
    }
    storedAccessToken = data.access_token;
    if (data.refresh_token) storedRefreshToken = data.refresh_token;
    storedAccessTokenExpiry = Date.now() + (data.expires_in ?? 86400) * 1000;
    return storedAccessToken;
  } catch (err) {
    logger.error('[TokenVault] getAuth0AccessToken error:', err);
    return null;
  }
}

/**
 * Get a short-lived access token for the given service via Auth0 Token Exchange (RFC 8693).
 * Requires Auth0 refresh token to be stored (user must complete connect flow first).
 */
export async function getToken(service: string, _scopes: string[]): Promise<string | null> {
  if (!isConfigured()) {
    warnFallback();
    return null;
  }
  if (!storedRefreshToken) {
    logger.log(`[TokenVault] getToken(${service}) — no Auth0 refresh token, user should connect first`);
    return null;
  }
  const connection = SERVICE_TO_CONNECTION[service.toLowerCase()] ?? service.toLowerCase();
  const domain = getDomain();
  const url = `${domain}/oauth/token`;
  const body = {
    client_id: process.env.AUTH0_CLIENT_ID,
    client_secret: process.env.AUTH0_CLIENT_SECRET,
    grant_type: AUTH0_TOKEN_EXCHANGE_GRANT,
    subject_token_type: SUBJECT_TOKEN_TYPE_REFRESH,
    subject_token: storedRefreshToken,
    requested_token_type: REQUESTED_TOKEN_TYPE,
    connection,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!res.ok || !data.access_token) {
      logger.warn('[TokenVault] token exchange failed for', connection, data);
      return null;
    }
    return data.access_token;
  } catch (err) {
    logger.error('[TokenVault] getToken error:', err);
    vaultUnavailableReason = err instanceof Error ? err.message : String(err);
    warnFallback();
    return null;
  }
}

/**
 * Revoke / disconnect the connected account for the given service.
 * Uses Auth0 My Account API when available.
 */
export async function revokeToken(service: string): Promise<void> {
  if (!isConfigured()) return;
  const accessToken = await getAuth0AccessToken();
  if (!accessToken) {
    logger.warn('[TokenVault] revokeToken: no access token');
    return;
  }
  const domain = getDomain();
  try {
    const listRes = await fetch(`${domain}/me/v1/connected-accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) {
      logger.warn('[TokenVault] list for revoke failed:', listRes.status);
      return;
    }
    const list = (await listRes.json()) as { connected_accounts?: Array<{ connection: string; id?: string }> };
    const accounts = list.connected_accounts ?? [];
    const account = accounts.find((a) => a.connection === (SERVICE_TO_CONNECTION[service.toLowerCase()] ?? service));
    if (!account?.id) {
      logger.log('[TokenVault] revokeToken: no connected account for', service);
      return;
    }
    const delRes = await fetch(`${domain}/me/v1/connected-accounts/${account.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!delRes.ok) logger.warn('[TokenVault] revoke delete failed:', delRes.status);
  } catch (err) {
    logger.error('[TokenVault] revokeToken error:', err);
  }
}

/**
 * List connected services from Auth0 My Account API (/me/v1/connected-accounts).
 */
export async function listConnectedServices(): Promise<ConnectedService[]> {
  if (!isConfigured()) return [];
  const accessToken = await getAuth0AccessToken();
  if (!accessToken) return [];
  const domain = getDomain();
  try {
    const res = await fetch(`${domain}/me/v1/connected-accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      logger.warn('[TokenVault] listConnectedServices failed:', res.status);
      return [];
    }
    const data = (await res.json()) as {
      connected_accounts?: Array<{
        connection: string;
        created_at?: string;
        expires_at?: string | null;
        scopes?: string[];
      }>;
    };
    const accounts = data.connected_accounts ?? [];
    return accounts.map((a) => ({
      name: a.connection,
      scopes: a.scopes ?? [],
      connectedAt: a.created_at ?? new Date().toISOString(),
      expiresAt: a.expires_at ?? null,
    }));
  } catch (err) {
    logger.error('[TokenVault] listConnectedServices error:', err);
    return [];
  }
}

/**
 * Return URL for the user to add a connected account (Auth0 authorize with connection).
 * Open in browser; on callback, exchange code for tokens and call storeAuth0Tokens.
 */
export function getConnectUrl(service: string): string | null {
  if (!isConfigured()) return null;
  const connection = SERVICE_TO_CONNECTION[service.toLowerCase()] ?? service.toLowerCase();
  const domain = process.env.AUTH0_DOMAIN!;
  const clientId = process.env.AUTH0_CLIENT_ID!;
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: 'atlarix://auth0/callback',
    scope: 'openid profile email offline_access',
    connection,
    prompt: 'login',
  });
  return `${base}/authorize?${params.toString()}`;
}

/**
 * Whether Token Vault is configured (even if currently unavailable)
 */
export function isTokenVaultConfigured(): boolean {
  return !!(
    process.env.AUTH0_DOMAIN &&
    process.env.AUTH0_CLIENT_ID &&
    process.env.AUTH0_TOKEN_VAULT_ID
  );
}

/**
 * Clear in-memory Auth0 / Token Vault session state (e.g. on New Chat).
 * Does not revoke remote connections (optional revoke may be slow); next tool use will re-prompt.
 */
export function clearAllTokenAuthSessions(): void {
  storedRefreshToken = null;
  storedAccessToken = null;
  storedAccessTokenExpiry = 0;
  logger.log('[TokenVault] clearAllTokenAuthSessions: in-memory tokens cleared');
}
