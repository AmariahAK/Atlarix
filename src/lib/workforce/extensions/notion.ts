/**
 * Notion — Workforce extension (Token Vault).
 * Read-only (read_content)
 */

import { createWorkforceExtension } from "../create-extension";

export const notionExtension = createWorkforceExtension("Notion", "notion", [
  "read_content",
]);
