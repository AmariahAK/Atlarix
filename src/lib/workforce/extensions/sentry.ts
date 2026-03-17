/**
 * Sentry — Workforce extension (Token Vault).
 * Scopes: project:read, event:read
 */

import { createWorkforceExtension } from "../create-extension";

export const sentryExtension = createWorkforceExtension("Sentry", "sentry", [
  "project:read",
  "event:read",
]);
