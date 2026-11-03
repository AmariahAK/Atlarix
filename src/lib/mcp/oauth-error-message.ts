/**
 * What an MCP sign-in failure says to the person, on every surface.
 *
 * The MCP SDK reports a server that refuses dynamic client registration as
 * `Incompatible auth server: does not support dynamic client registration`,
 * which is true and useless: Slack's MCP server is the usual case, and the
 * way through is a pre-registered app, set up once on atlarix.dev. The app,
 * the CLI, the editors and the VS Code panel all show the message this
 * returns, so the pointer lives here and nowhere else.
 */

export const MCP_CONNECTOR_GUIDE_URL = "https://atlarix.dev/guides/slack-mcp";

const NO_REGISTRATION = /does not support dynamic client registration|dynamic_client_registration_not_supported|client_registration_required/i;

/** The message to show for an MCP OAuth failure; the SDK's own text unless it is the registration case. */
export function describeMcpOAuthError(error: unknown, guideUrl: string = MCP_CONNECTOR_GUIDE_URL): string {
  const message = error instanceof Error ? error.message : String(error);
  if (NO_REGISTRATION.test(message)) {
    return `This server needs a pre-registered app. Set it up once on atlarix.dev: ${guideUrl}`;
  }
  return message;
}

/** Whether the failure is the registration case (the caller may point at the guide instead of retrying). */
export function needsPreRegisteredClient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NO_REGISTRATION.test(message);
}
