/**
 * What an MCP sign-in failure says to the person, on every surface.
 *
 * The MCP SDK reports a server that refuses dynamic client registration as
 * `Incompatible auth server: does not support dynamic client registration`,
 * which is true and useless. The person needs the next step, not the reason
 * (owner, 2026-11-07): for Slack's MCP server that is Atlarix in Slack; for
 * any other server, a key if it offers one. The app, the CLI, the editors and
 * the VS Code panel all show the message this returns, so it lives here once.
 */

/** The page that sets up Atlarix in Slack. Released builds link this path. */
export const MCP_CONNECTOR_GUIDE_URL = "https://atlarix.dev/guides/slack-mcp";

const NO_REGISTRATION = /does not support dynamic client registration|dynamic_client_registration_not_supported|client_registration_required/i;

function isSlack(serverUrl: string | undefined): boolean {
  if (!serverUrl) return false;
  try {
    const host = new URL(serverUrl).hostname.toLowerCase();
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}

/** The message to show for an MCP OAuth failure; the SDK's own text unless it is the registration case. */
export function describeMcpOAuthError(
  error: unknown,
  serverUrl?: string,
  guideUrl: string = MCP_CONNECTOR_GUIDE_URL,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (NO_REGISTRATION.test(message)) {
    return isSlack(serverUrl)
      ? `Use Atlarix in Slack instead: ${guideUrl}`
      : "Atlarix can't sign in to this server. If it offers an API key, add it with the key instead.";
  }
  return message;
}

/** Whether the failure is the registration case (the caller may point at the guide instead of retrying). */
export function needsPreRegisteredClient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NO_REGISTRATION.test(message);
}
