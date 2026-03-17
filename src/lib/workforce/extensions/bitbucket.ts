/**
 * Bitbucket Pipelines — Workforce extension (Token Vault).
 * Scopes: pipeline:read, repository:read
 */

import { createWorkforceExtension } from "../create-extension";

export const bitbucketExtension = createWorkforceExtension("Bitbucket Pipelines", "bitbucket", [
  "pipeline:read",
  "repository:read",
]);
