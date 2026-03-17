/**
 * Linear — Workforce extension (Token Vault).
 * Read + write
 */

import { createWorkforceExtension } from "../create-extension";

export const linearExtension = createWorkforceExtension("Linear", "linear", [
  "read",
  "write",
]);
