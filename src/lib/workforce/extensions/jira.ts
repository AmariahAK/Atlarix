/**
 * Jira — Workforce extension (Token Vault).
 * Scopes: read/write jira-work
 */

import { createWorkforceExtension } from "../create-extension";

export const jiraExtension = createWorkforceExtension("Jira", "jira", [
  "read:jira-work",
  "write:jira-work",
]);
