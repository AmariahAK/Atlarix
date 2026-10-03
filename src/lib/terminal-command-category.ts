/**
 * First-token command category for workspace-scoped terminal permissions.
 *
 * Danger classification is NOT here anymore — it moved to a single source of
 * truth in `dangerous-commands.ts` (regex patterns + risky first-tokens, keyed
 * by `dangerLabelKey`). This module now only computes the coarse first-token
 * category used for non-dangerous command always-allow rules.
 */

import { stripLeadingWrappers } from "./command-segments";

export type CommandPermissionDecision = "always_allow" | "always_deny";

export function getCommandCategory(command: string): string {
  // The same prefix-stripping the gate classifies with (`X=1 npm test` → npm).
  // An "always allow" is SAVED under this key and CHECKED by the gate's; when
  // they differed, a rule saved for a prefixed command could never match.
  const trimmed = stripLeadingWrappers(command);
  if (!trimmed) return "";
  const first = trimmed.split(/\s+/)[0] ?? "";
  return first.toLowerCase();
}
