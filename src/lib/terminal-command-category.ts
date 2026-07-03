/**
 * First-token command category for workspace-scoped terminal permissions.
 *
 * Danger classification is NOT here anymore — it moved to a single source of
 * truth in `dangerous-commands.ts` (regex patterns + risky first-tokens, keyed
 * by `dangerLabelKey`). This module now only computes the coarse first-token
 * category used for non-dangerous command always-allow rules.
 */

export type CommandPermissionDecision = "always_allow" | "always_deny";

export function getCommandCategory(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const first = trimmed.split(/\s+/)[0] ?? "";
  return first.toLowerCase();
}
