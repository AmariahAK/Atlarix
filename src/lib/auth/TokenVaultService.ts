/**
 * Token Vault Service — v4.0 Workforce
 * =====================================
 * Auth0-powered agent authentication. Agents request tokens at runtime;
 * Auth0 handles OAuth flows, token refresh, consent delegation.
 * When Auth0 is unavailable (offline/misconfigured), falls back to existing
 * credential store and notifies via callback (toast).
 */

import log from 'electron-log';
import { buildConfig } from '@/generated/build-config';

const logger = log.scope('token-vault');

export interface ConnectedService {
  name: string;
  scopes: string[];
  connectedAt: string;
  expiresAt: string | null;
}

let vaultUnavailableReason: string | null = null;
let onFallbackWarning: ((message: string) => void) | null = null;

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
  // v4.0: PostHog (no tokens or PII)
  if (!fallbackCaptured) {
    fallbackCaptured = true;
    import('../../main/lib/analytics').then(({ capture }) => {
      capture('token_vault_fallback', { reason: vaultUnavailableReason ? 'error' : 'unconfigured' });
    }).catch(() => {});
  }
}

function isConfigured(): boolean {
  const domain = buildConfig.AUTH0_DOMAIN;
  const clientId = buildConfig.AUTH0_CLIENT_ID;
  const clientSecret = buildConfig.AUTH0_CLIENT_SECRET;
  const vaultId = buildConfig.AUTH0_TOKEN_VAULT_ID;
  const audience = buildConfig.AUTH0_AUDIENCE;
  if (!domain || !clientId || !clientSecret || !vaultId || !audience) {
    vaultUnavailableReason = 'Missing AUTH0_* env vars (see .env.example and SECRETS.md)';
    return false;
  }
  vaultUnavailableReason = null;
  return true;
}

/**
 * Get a short-lived access token for the given service and scopes.
 * If user has not consented, triggers consent flow (caller should listen for
 * token-vault:consent-required). On vault unavailable, returns null and
 * triggers fallback warning.
 */
export async function getToken(service: string, scopes: string[]): Promise<string | null> {
  if (!isConfigured()) {
    warnFallback();
    return null;
  }

  try {
    // TODO: Integrate with Auth0 Token Vault / Token Exchange (RFC 8693)
    // https://auth0.com/ai/docs/intro/token-vault
    // For now return null so callers use fallback credential store
    logger.log(`[TokenVault] getToken(${service}, scopes) — Auth0 integration pending, use fallback`);
    return null;
  } catch (err) {
    logger.error('[TokenVault] getToken error:', err);
    vaultUnavailableReason = err instanceof Error ? err.message : String(err);
    warnFallback();
    return null;
  }
}

/**
 * Revoke token / disconnect service for the user
 */
export async function revokeToken(service: string): Promise<void> {
  if (!isConfigured()) {
    return;
  }
  try {
    // TODO: Revoke in Auth0 and/or clear workforce_connected_services row
    logger.log(`[TokenVault] revokeToken(${service}) — integration pending`);
  } catch (err) {
    logger.error('[TokenVault] revokeToken error:', err);
  }
}

/**
 * List connected services (from Auth0 or workforce_connected_services)
 */
export async function listConnectedServices(): Promise<ConnectedService[]> {
  if (!isConfigured()) {
    return [];
  }
  try {
    // TODO: Fetch from Auth0 Connected Accounts or Supabase workforce_connected_services
    return [];
  } catch (err) {
    logger.error('[TokenVault] listConnectedServices error:', err);
    return [];
  }
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
