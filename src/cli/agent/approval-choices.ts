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
  /** The gate's key for the segment that asked (`ls`, `danger:rm-rf`, `mutate:git-write`): what "always" saves. */
  commandCategory?: string;
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
      // Named by what "always" saves: the gate's key for the part that asked.
      // From the whole command, `cd x && ls …` came out as "`&&` commands" (QA).
      const key = p.commandCategory || getCommandCategory(p.command);
      const what =
        p.isDangerous || key.startsWith("danger:")
          ? "this command"
          : key.startsWith("mutate:")
            ? "changes like this"
            : `\`${key}\` commands`;
      choices.push({ label: `Yes, and always allow ${what} in this folder`, mode: "always_allow" });
    }
  } else if (p.path) {
    if (p.canAlwaysAllowFile !== false) {
      choices.push({ label: "Yes, and allow edits to this file from now on", mode: "always_allow_file" });
    }
    if (p.canAlwaysAllowDirectory !== false && p.fileParentDir) {
      choices.push({ label: `Yes, and allow edits in ${nativeDir(p.fileParentDir)} from now on`, mode: "always_allow_directory" });
    }
  }
  choices.push({ label: "No — tell Atlarix what to do instead", mode: "deny" });
  return choices;
}

/**
 * The line left in the transcript once a card is answered, as Codex CLI and
 * Claude Code do: what you approved, and for how long. Shared with the editors
 * (acp/updates.ts shows the same `approved:` line). Null when there is nothing
 * to confirm: you said no, or the request names no command or file.
 */
export function approvalConfirmation(a: PendingApproval, mode: ApprovalChoice["mode"]): string | null {
  if (mode === "deny") return null;
  const p = firstPreview(a);
  const code = (s: string) => `\`${oneLineOf(s)}\``;
  let what: string | null = null;
  if (p.command) {
    if (mode === "always_allow") {
      const key = p.commandCategory || getCommandCategory(p.command);
      what =
        p.isDangerous || key.startsWith("danger:")
          ? `always run ${code(p.command)} in this folder`
          : key.startsWith("mutate:")
            ? `always make changes like ${code(p.command)} in this folder`
            : `always run commands that start with ${code(key)} in this folder`;
    } else {
      what = `run ${code(p.command)} this time`;
    }
  } else if (p.deniedPath) {
    what = `write to ${code(p.deniedPath)} this time`;
  } else if (p.path) {
    const verb = p.type === "delete" ? "delete" : p.type === "create" ? "create" : "edit";
    if (mode === "always_allow_directory" && p.fileParentDir) what = `edit files in ${code(nativeDir(p.fileParentDir))} from now on`;
    else if (mode === "always_allow_file") what = `edit ${code(p.path)} from now on`;
    else what = `${verb} ${code(p.path)} this time`;
  }
  return what ? `✓ You approved Atlarix to ${what}` : null;
}

/** A command on one line, at most 120 characters: the line is a receipt, not the command. */
function oneLineOf(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

export function approvalTitle(a: PendingApproval): string {
  const p = firstPreview(a);
  if (p.command) return "Run this command?";
  if (p.deniedPath) return "Allow writing outside the sandbox?";
  if (p.type === "delete") return "Delete this file?";
  if (p.type === "create") return "Create this file?";
  if (p.path) return "Edit this file?";
  // A standing job (the automations tool): say which way, its description has the rest.
  if (a.request.operation === "automation_write") {
    // The tool says which (QA: a set_notify change was titled "Create").
    const action = (p as { action?: string }).action;
    if (action === "delete") return "Delete this automation?";
    if (action === "update") return "Change this automation?";
    return "Create this automation?";
  }
  return "Allow this?";
}

/**
 * An automation's approval, in plain lines: when it runs, what each run does,
 * who hears about it. The card said only 'Create "X" — runs on the schedule
 * `0 9 * * 1-5`', so you approved blind (QA). The desktop's card shows the same.
 */
export function automationDetails(a: PendingApproval): string[] {
  if (a.request.operation !== "automation_write") return [];
  const p = firstPreview(a) as Preview & {
    action?: string;
    triggerSummary?: string;
    runMode?: string;
    notifyAgent?: boolean;
    grantsMcpConsent?: string;
    input?: { prompt?: string; trigger?: { kind?: string; cron?: string } };
  };
  if (p.action === "delete") return [];
  const lines: string[] = [];
  const cron = p.input?.trigger?.kind === "schedule" ? p.input.trigger.cron : undefined;
  const clock = cron ? clockOf(cron) : null;
  if (p.triggerSummary) lines.push(`When: ${p.triggerSummary.replace(/`/g, "")}${clock ? ` (${clock})` : ""}`);
  if (p.runMode === "read-only") lines.push(`Each run: Atlarix runs a read-only task${p.input?.prompt ? `: “${p.input.prompt.trim()}”` : ""}`);
  else if (p.runMode) lines.push("Each run: just tells you it fired (no model, no tokens)");
  // A fresh result wakes a chat in this folder (agent-delivery.ts).
  if (p.notifyAgent != null) lines.push(p.notifyAgent ? "Results: to you, and Atlarix wakes up with them to act" : "Results: to you only");
  if (p.grantsMcpConsent) lines.push(`It calls ${p.grantsMcpConsent} on its own, without asking each time.`);
  return lines;
}

/** "30 8 * * 1-5" → "8:30 AM, Mon–Fri"; null when it isn't a simple daily time. */
function clockOf(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[0]!) || !/^\d+$/.test(f[1]!) || f[2] !== "*" || f[3] !== "*") return null;
  const h = Number(f[1]), m = Number(f[0]);
  const time = `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  const days: Record<string, string> = { "*": "every day", "1-5": "Mon–Fri", "0,6": "weekends", "6,0": "weekends", "1": "Mondays", "0": "Sundays", "5": "Fridays" };
  return `${time}, ${days[f[4]!] ?? `weekdays ${f[4]}`}`;
}

/**
 * A folder as its own system writes it, with its separator at the end:
 * "C:\Users\Public\", "src/" (QA, Windows). A relative folder takes the running
 * system's: on Windows "src/" read as a Unix path (QA, 2026-10-21).
 */
export function nativeDir(dir: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32" || /^[A-Za-z]:[\\/]|^\\\\/.test(dir);
  const d = win ? dir.replace(/\//g, "\\") : dir;
  const sep = win ? "\\" : "/";
  return d.endsWith(sep) ? d : d + sep;
}

/**
 * Whether an edit's file is outside the open project: the card says so, in
 * the warning colour (QA, Windows: a write to C:\Users\Public read as
 * routine). Windows paths compare without case and either separator.
 */
export function outsideWorkspace(file: string | undefined, workspace: string | undefined): boolean {
  if (!file || !workspace) return false;
  const abs = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(file);
  if (!abs) return false;
  const win = /^[A-Za-z]:/.test(file) || /^[A-Za-z]:/.test(workspace);
  const norm = (x: string) => {
    const n = x.replace(/\\/g, "/").replace(/\/+$/, "");
    return win ? n.toLowerCase() : n;
  };
  const f = norm(file);
  const w = norm(workspace);
  return f !== w && !f.startsWith(w + "/");
}

