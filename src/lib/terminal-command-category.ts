/**
 * First-token command category for workspace-scoped terminal permissions.
 */

export const DANGEROUS_CATEGORIES = new Set([
  "rm",
  "sudo",
  "kill",
  "pkill",
  "chmod",
  "chown",
  "curl",
  "wget",
  "bash",
  "sh",
  "zsh",
  "eval",
  "exec",
  "dd",
  "mkfs",
  "fdisk",
  "reboot",
  "shutdown",
  "poweroff",
]);

export type CommandPermissionDecision = "always_allow" | "always_deny";

export function getCommandCategory(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const first = trimmed.split(/\s+/)[0] ?? "";
  return first.toLowerCase();
}

export function isDangerousCategory(category: string): boolean {
  return DANGEROUS_CATEGORIES.has(category.toLowerCase());
}
