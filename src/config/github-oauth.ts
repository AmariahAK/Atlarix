/**
 * GitHub OAuth App (Device Flow) for repo clone / connect.
 *
 * The browser page title ("Authorize …") comes from the OAuth app name on GitHub,
 * not from Atlarix UI. Register an app named **Atlarix** and set `OAUTH_CLIENT_ID`:
 * https://github.com/settings/applications/new → enable Device Flow.
 *
 * Legacy Dyad client ID is kept only as a dev fallback until CI uses the Atlarix app.
 */
export const LEGACY_DYAD_GITHUB_DEVICE_CLIENT_ID = "Ov23liWV2HdC0RBLecWx";

/** Read at call time — not module load — so preload-env runs first. */
export function getGithubDeviceFlowClientId(): string {
  const fromEnv =
    process.env.OAUTH_CLIENT_ID?.trim() ||
    process.env.GITHUB_CLIENT_ID?.trim();
  return fromEnv || LEGACY_DYAD_GITHUB_DEVICE_CLIENT_ID;
}

export function isLegacyDyadGithubDeviceClient(): boolean {
  return getGithubDeviceFlowClientId() === LEGACY_DYAD_GITHUB_DEVICE_CLIENT_ID;
}

/** GitHub OAuth App client IDs are short public strings (often `Ov23li…`), not 40-char hex secrets. */
export function looksLikeInvalidGithubOAuthClientId(clientId: string): boolean {
  if (!clientId) return true;
  if (/^Ov23li/i.test(clientId)) return false;
  if (/^Iv1\./i.test(clientId)) return false;
  if (/^[a-f0-9]{40}$/i.test(clientId)) return true;
  return clientId.length > 64;
}
