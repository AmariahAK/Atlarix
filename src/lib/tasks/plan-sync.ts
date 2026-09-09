/**
 * Keeps `.atlarix/ATLARIX_PLAN.md` aligned with the in-memory task ledger (living plan).
 */

import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";
import type { TaskLedger } from "./task-ledger";

const logger = log.scope("plan-sync");

const PLAN_REL = path.join(".atlarix", "ATLARIX_PLAN.md");

function statusLabel(ledger: TaskLedger): string {
  if (ledger.finishReason === "complete") return "Complete";
  if (ledger.finishReason === "failed") return "Failed";
  if (ledger.finishReason === "cancelled") return "Cancelled";
  return "In progress";
}

function checkboxForStep(status: string): string {
  switch (status) {
    case "done":
      return "x";
    case "in_progress":
      return "~";
    case "failed":
      return "!";
    default:
      return " ";
  }
}

/**
 * Rewrite ATLARIX_PLAN.md from the current ledger (structured steps + metadata).
 * Never throws.
 */
export async function syncPlanFile(
  workspacePath: string,
  ledger: TaskLedger,
): Promise<void> {
  try {
    if (!workspacePath?.trim()) return;

    const taskHead =
      ledger.originalTask.split("\n")[0]?.trim() || ledger.originalTask;
    const lines: string[] = [
      "# ATLARIX Plan",
      "",
      `**Status:** ${statusLabel(ledger)}`,
      `**Version:** 1`,
      `**Started:** ${new Date(ledger.createdAt).toISOString()}`,
      `**Task:** ${taskHead.slice(0, 800)}`,
      `**Turn:** ${ledger.turnId}`,
      "",
      "## Steps",
    ];

    for (let i = 0; i < ledger.steps.length; i++) {
      const s = ledger.steps[i]!;
      const mark = checkboxForStep(s.status);
      lines.push(`${i + 1}. [${mark}] ${s.description}`);
    }

    lines.push("", "## Notes", "");
    lines.push(
      "_Ledger-driven plan file; step-level notes appear in task context during the run._",
      "",
    );

    const allTerminal = ledger.steps.every(
      (s) => s.status === "done" || s.status === "failed",
    );
    const complete = ledger.finishReason === "complete" && allTerminal;
    if (complete) {
      const files = [
        ...new Set(ledger.steps.flatMap((s) => s.filesWritten ?? [])),
      ].filter(Boolean);
      if (files.length > 0) {
        lines.push("## Completion", "");
        for (const f of files) {
          lines.push(`- ${f}`);
        }
        lines.push("");
      }
    }

    const dir = path.join(workspacePath, ".atlarix");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, PLAN_REL),
      lines.join("\n"),
      "utf8",
    );
    let mtime: number | null = null;
    try {
      const st = await fs.stat(path.join(workspacePath, PLAN_REL));
      mtime = st.mtimeMs;
    } catch {
      /* ignore */
    }
    const { emitPlanFileUpdated } = await import(
      "@/ipc/utils/emit_plan_file_updated"
    );
    emitPlanFileUpdated(workspacePath, mtime);
  } catch (e) {
    logger.warn("syncPlanFile failed:", e);
  }
}

/**
 * Copy the current plan file into `.atlarix/plans/archive/` before it is replaced.
 * `planRelativePath` is workspace-relative POSIX (e.g. `.atlarix/ATLARIX_PLAN.md` or `frontend/.atlarix/ATLARIX_PLAN.md`).
 */
export async function archiveCurrentPlan(
  workspacePath: string,
  planRelativePath: string = ".atlarix/ATLARIX_PLAN.md",
): Promise<void> {
  try {
    if (!workspacePath?.trim()) return;
    const norm = planRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const src = path.join(workspacePath, norm);
    let body: string;
    try {
      body = await fs.readFile(src, "utf8");
    } catch {
      return;
    }
    if (!body.trim()) return;

    const archiveSubdir = path.join(".atlarix", "plans", "archive");
    const destDir = path.join(workspacePath, archiveSubdir);
    await fs.mkdir(destDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destName = `ATLARIX_PLAN-${stamp}.md`;
    await fs.writeFile(path.join(destDir, destName), body, "utf8");
  } catch (e) {
    logger.warn("archiveCurrentPlan failed:", e);
  }
}

export function isAtlarixPlanRelativePath(relPosix: string): boolean {
  const norm = relPosix.replace(/\\/g, "/");
  return (
    norm === ".atlarix/ATLARIX_PLAN.md" ||
    norm.endsWith("/.atlarix/ATLARIX_PLAN.md") ||
    norm === "ATLARIX_PLAN.md" ||
    norm.endsWith("/ATLARIX_PLAN.md")
  );
}

/**
 * Workspace-relative POSIX paths that never require user approval.
 *
 * INVERTED IN v14.45, and the inversion is the point. This was allow-by-default —
 * everything under `.atlarix/` was auto-approved except a carve-out list — and that
 * shape has now failed twice. When it returns true, `bufferOperation` suppresses the
 * permission event entirely: the write lands with NO approval card at all.
 *
 * First failure: `.atlarix/hooks/hooks.json` was handed to `/bin/sh -c` on every tool
 * call, so the agent could grant itself arbitrary shell (fixed v14.25.0 by adding
 * `hooks/` to the exception list). Second failure: the exception list named
 * `atlarix.md` and `permissions.json` and reasoned explicitly about "durable
 * prompt-injection escalation" — while missing `.atlarix/skills/modes/*.md`, which
 * REPLACED the mode's operating instructions and landed AHEAD of the base system
 * prompt, and `.atlarix/skills/subagents/*.md`, which was a write-capable sub-agent's
 * entire prompt. Both outranked the two files the list did protect.
 *
 * The lesson is not "add three more names". A list of exceptions has to be extended
 * every time the product grows a new authority-bearing convention, and the failure mode
 * is silent: the new convention simply arrives auto-approved. So the default flipped.
 * Only paths that are explicitly, provably inert are auto-approved; everything else
 * under `.atlarix/` gets a card. A future convention arrives PROTECTED, and the cost of
 * getting the allowlist wrong is one extra approval prompt rather than a silent
 * escalation.
 *
 * What is on the allowlist and why: these exist so the agent can do its own bookkeeping
 * without interrupting the user, and none of them is read back as instructions, executed,
 * or consulted for tool gating.
 */
export function isAlwaysAutoApproveAtlarixRelativePath(
  relPosix: string,
): boolean {
  const norm = relPosix.replace(/\\/g, "/").replace(/^\/+/, "");

  // Outside the workspace is never blanket-approved. With granted folders a path
  // renders as `../other-repo/.atlarix/…`, and silently writing another project's
  // agent config is the same hole one directory over (fixed v14.25.0).
  if (norm.startsWith("../") || norm === "..") return false;

  // The ignore file is inert: read by our own file walker, never by the model.
  if (norm === ".atlarixignore") return true;
  if (norm === ".atlarix/.atlarixignore") return true;

  /**
   * Agent bookkeeping. `plans/` is the session plan the `plan` tool maintains and
   * `archive/` is where finished plans go — both are the agent's own scratch state,
   * and both are already visible to the user in the plan UI, which is what makes
   * approving each write pure friction.
   *
   * A plan file IS read back into the prompt, so this is the one allowlist entry worth
   * re-examining if the plan's role ever grows. It stays because a plan cannot gate a
   * tool or claim standing authority over future turns — it is a checklist the model
   * wrote for itself, in a surface the user is watching.
   */
  const segments = norm.split("/");
  if (segments[0] === ".atlarix" && segments.length > 1) {
    const dir = segments[1];
    if (dir === "plans" || dir === "archive") return true;
  }

  // Everything else — including anything new — requires a card.
  return false;
}
