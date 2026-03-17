/**
 * GitLab CI — Workforce extension (Token Vault).
 * Scopes: read_api, read_repository
 */

import { createWorkforceExtension } from "../create-extension";

export const gitlabExtension = createWorkforceExtension("GitLab CI", "gitlab", [
  "read_api",
  "read_repository",
]);
