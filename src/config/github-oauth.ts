/**
 * GitHub OAuth App (Device Flow) for repo clone / connect.
 *
 * The browser page title ("Authorize …") comes from the OAuth app name on GitHub,
 * not from Atlarix UI. Register an app named **Atlarix** and set `OAUTH_CLIENT_ID`:
 * https://github.com/settings/applications/new → enable Device Flow.
 *
 * `OAUTH_CLIENT_ID` is REQUIRED. It has been a set CI secret since 2026-05-29, so
 * every shipped build already authorizes as Atlarix; the inherited fork-era client id
 * that used to serve as a dev fallback is gone. Missing it now fails loudly in dev
 * rather than silently showing the user another vendor's name on the consent screen.
 */

/** Read at call time — not module load — so preload-env runs first. */
export function getGithubDeviceFlowClientId(): string {
  const fromEnv = process.env.OAUTH_CLIENT_ID?.trim();
  if (!fromEnv) {
    throw new Error(
      "OAUTH_CLIENT_ID is not set. Register a GitHub OAuth app named Atlarix with " +
        "Device Flow enabled and set OAUTH_CLIENT_ID in your .env.",
    );
  }
  return fromEnv;
}

/** GitHub OAuth App client IDs are short public strings (often `Ov23li…`), not 40-char hex secrets. */
export function looksLikeInvalidGithubOAuthClientId(clientId: string): boolean {
  if (!clientId) return true;
  if (/^Ov23li/i.test(clientId)) return false;
  if (/^Iv1\./i.test(clientId)) return false;
  if (/^[a-f0-9]{40}$/i.test(clientId)) return true;
  return clientId.length > 64;
}
