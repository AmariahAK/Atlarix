/**
 * Slack — Workforce extension (Token Vault).
 * Scopes: channels:read, chat:write, im:read, users:read
 */

import { createWorkforceExtension } from "../create-extension";

export const slackExtension = createWorkforceExtension("Slack", "slack", [
  "channels:read",
  "chat:write",
  "im:read",
  "users:read",
]);
