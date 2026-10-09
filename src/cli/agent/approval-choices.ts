/**
 * The permission prompt's choices and title, without UI: shared by the TUI's
 * dialog (tui/Approval.tsx) and the editor's Allow/Deny (acp/permissions.ts).
 * Choices map to the approval modes the desktop sends (execute-permission).
 */
import { getCommandCategory } from "@/lib/terminal-command-category";
import type { PendingApproval } from "./session";

export type ApprovalChoice = { label: string; mode: "once" | "always_allow" | "always_allow_file" | "always_allow_directory" | "deny" };

export interface Preview {
  command?: string;
  workingDirectory?: string;
  description?: string;
  isDangerous?: boolean;
  dangerExplanation?: string;
  systemScope?: boolean;
  systemScopeExplanation?: string;
  path?: string;
  type?: string;
  /** NOT reliably text (edit_file sends a summary object); see approval-diff.ts. */
  diff?: unknown;
  content?: string;
  oldContent?: string;
  lines?: number;
  deniedPath?: string;
  grantPath?: string;
  canAlwaysAllow?: boolean;
  canAlwaysAllowFile?: boolean;
  canAlwaysAllowDirectory?: boolean;
  fileParentDir?: string;
}

export function firstPreview(a: PendingApproval): Preview {
  const p = a.request.preview;
  return ((Array.isArray(p) ? p[0] : p) ?? {}) as Preview;
}

/**
 * The same choices as the desktop's card (InlinePermissionApprovals.tsx): an
 * "always" option unless the request says it cannot be remembered
 * (`canAlwaysAllow: false`, e.g. a change outside the project, which is never
 * blanket-approved). A risky command's rule covers that exact command; any
 * other command's covers its category (`npm`, `brew`).
 */
export function approvalChoices(a: PendingApproval): ApprovalChoice[] {
  const p = firstPreview(a);
  const choices: ApprovalChoice[] = [{ label: "Yes", mode: "once" }];
  if (p.command) {
    if (p.canAlwaysAllow !== false) {
      const what = p.isDangerous ? "this command" : `\`${getCommandCategory(p.command)}\` commands`;
      choices.push({ label: `Yes, and always allow ${what} in this folder`, mode: "always_allow" });
    }
  } else if (p.path) {
    if (p.canAlwaysAllowFile !== false) {
      choices.push({ label: "Yes, and allow edits to this file from now on", mode: "always_allow_file" });
    }
    if (p.canAlwaysAllowDirectory !== false && p.fileParentDir) {
      choices.push({ label: `Yes, and allow edits in ${p.fileParentDir}/ from now on`, mode: "always_allow_directory" });
    }
  }
  choices.push({ label: "No — tell Atlarix what to do instead", mode: "deny" });
  return choices;
}

export function approvalTitle(a: PendingApproval): string {
  const p = firstPreview(a);
  if (p.command) return "Run this command?";
  if (p.deniedPath) return "Allow writing outside the sandbox?";
  if (p.type === "delete") return "Delete this file?";
  if (p.type === "create") return "Create this file?";
  if (p.path) return "Edit this file?";
  return "Allow this?";
}
