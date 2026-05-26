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
export async function syncPlanFile(workspacePath: string, ledger: TaskLedger): Promise<void> {
  try {
    if (!workspacePath?.trim()) return;

    const taskHead = ledger.originalTask.split("\n")[0]?.trim() || ledger.originalTask;
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
    lines.push("_Ledger-driven plan file; step-level notes appear in task context during the run._", "");

    const allTerminal = ledger.steps.every((s) => s.status === "done" || s.status === "failed");
    const complete = ledger.finishReason === "complete" && allTerminal;
    if (complete) {
      const files = [...new Set(ledger.steps.flatMap((s) => s.filesWritten ?? []))].filter(Boolean);
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
    await fs.writeFile(path.join(workspacePath, PLAN_REL), lines.join("\n"), "utf8");
    let mtime: number | null = null;
    try {
      const st = await fs.stat(path.join(workspacePath, PLAN_REL));
      mtime = st.mtimeMs;
    } catch {
      /* ignore */
    }
    const { emitPlanFileUpdated } = await import("@/ipc/utils/emit_plan_file_updated");
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

/** Workspace-relative POSIX paths that never require user approval (internal Atlarix metadata). */
export function isAlwaysAutoApproveAtlarixRelativePath(relPosix: string): boolean {
  const norm = relPosix.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm === ".atlarix/.atlarixignore" || norm.endsWith("/.atlarix/.atlarixignore")) return true;
  if (norm === ".atlarixignore" || norm.endsWith("/.atlarixignore")) return true;
  if (norm === ".atlarix" || norm.startsWith(".atlarix/")) return true;
  if (norm.includes("/.atlarix/")) return true;
  return false;
}
