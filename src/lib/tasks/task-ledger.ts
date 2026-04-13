/**
 * External task ledger: survives compaction by storing structured progress outside chat history.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { atlasDir } from "../snapshot/workspace-hash";
import {
  getRemainingSteps,
  buildPendingStepsContinuationPrompt,
} from "./completion-detector";
import { ArchitectPlanPayloadSchema } from "../agents/agent-handoff-schemas";

/** Tools that indicate substantive work finished for a single-step ledger (no plan file). */
const LEDGER_COMPLETION_TOOLS = new Set([
  "write_file",
  "write_multiple_files",
  "replace_code",
  "insert_code",
  "delete_lines",
  "edit_file_section",
  "run_command",
]);

export type StepStatus = "pending" | "in_progress" | "done" | "failed";

export interface TaskStep {
  id: number;
  description: string;
  status: StepStatus;
  filesRead?: string[];
  filesWritten?: string[];
  result?: string;
  completedAt?: number;
}

export interface TaskLedger {
  turnId: string;
  chatId: number;
  originalTask: string;
  chatType: "workspace" | "general";
  workspacePath?: string;
  createdAt: number;
  steps: TaskStep[];
  currentStepId: number;
  finishReason?: "complete" | "failed" | "cancelled" | "in_progress";
}

const TASK_STATE_SUBDIR = "task-state";

const memoryLedgers = new Map<string, TaskLedger>();

const ledgerPlanUiNotifiers = new Map<number, (ledger: TaskLedger) => void>();

export function registerLedgerPlanUiNotifier(
  chatId: number,
  notifier: (ledger: TaskLedger) => void,
): void {
  ledgerPlanUiNotifiers.set(chatId, notifier);
}

export function unregisterLedgerPlanUiNotifier(chatId: number): void {
  ledgerPlanUiNotifiers.delete(chatId);
}

function notifyLedgerPlanUiIfRegistered(ledger: TaskLedger): void {
  const cb = ledgerPlanUiNotifiers.get(ledger.chatId);
  if (!cb) return;
  try {
    cb(ledger);
  } catch {
    /* noop */
  }
}

/** Emit plan UI for this turn if a ledger row still exists (e.g. stream end while steps remain). */
export function notifyPlanUiForTurnIfPresent(turnId: string): void {
  const L = memoryLedgers.get(turnId);
  if (L) notifyLedgerPlanUiIfRegistered(L);
}

/**
 * Safe directory name under task-state (logical turnId may contain `:` e.g. plan:7).
 * Numeric turn ids (e.g. from `String(placeholderAssistantMessage.id)`) are internal SQLite row
 * ids used as stable per-turn keys; only `plan:*` style ids are user-facing in ATLARIX_PLAN.md.
 */
export function sanitizeLedgerDirSegment(turnId: string): string {
  return turnId.replace(/[:/\\]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "ledger";
}

/** Stable turn id for the workspace-scoped plan ledger. Invalid ids (null, undefined, non-finite, ≤0) → null — callers skip silently. */
export function planLedgerTurnId(workspaceId: number | undefined | null): string | null {
  if (
    workspaceId == null ||
    !Number.isFinite(workspaceId) ||
    workspaceId <= 0
  ) {
    return null;
  }
  return `plan:${workspaceId}`;
}

export function getWorkspacePlanLedger(workspaceId: number | undefined | null): TaskLedger | undefined {
  if (
    workspaceId == null ||
    !Number.isFinite(workspaceId) ||
    workspaceId <= 0
  ) {
    return undefined;
  }
  const tid = planLedgerTurnId(workspaceId);
  if (tid == null) return undefined;
  return getLedger(tid);
}

/** True when the workspace plan ledger exists and has pending or in-progress steps. */
export function hasActivePlanLedger(workspaceId: number | undefined | null): boolean {
  if (
    workspaceId == null ||
    !Number.isFinite(workspaceId) ||
    workspaceId <= 0
  ) {
    return false;
  }
  const L = getWorkspacePlanLedger(workspaceId);
  if (!L || L.finishReason === "cancelled") return false;
  return L.steps.some((s) => s.status === "pending" || s.status === "in_progress");
}

/** Remove one ledger from memory only (disk JSON may remain as audit trail). */
export function clearLedger(turnId: string): void {
  memoryLedgers.delete(turnId);
}

function scheduleLivingPlanSync(turnId: string): void {
  const L = memoryLedgers.get(turnId);
  if (!L?.workspacePath) return;
  const wp = L.workspacePath;
  const snap: TaskLedger = {
    ...L,
    steps: L.steps.map((s) => ({ ...s })),
  };
  void import("./plan-sync").then(({ syncPlanFile }) => {
    void syncPlanFile(wp, snap);
  });
}

export function clearInMemoryTaskLedgers(): void {
  memoryLedgers.clear();
}

function ledgerRootDir(workspacePath: string, turnId: string): string {
  return path.join(atlasDir(workspacePath), TASK_STATE_SUBDIR, sanitizeLedgerDirSegment(turnId));
}

export async function persistLedgerToDisk(ledger: TaskLedger): Promise<void> {
  if (!ledger.workspacePath) return;
  const root = ledgerRootDir(ledger.workspacePath, ledger.turnId);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "ledger.json"), JSON.stringify(ledger, null, 2), "utf8");
}

export async function loadLedgerFromDisk(
  workspacePath: string,
  turnId: string,
): Promise<TaskLedger | null> {
  try {
    const p = path.join(ledgerRootDir(workspacePath, turnId), "ledger.json");
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as TaskLedger;
  } catch {
    return null;
  }
}

export function getLedger(turnId: string): TaskLedger | undefined {
  return memoryLedgers.get(turnId);
}

export async function hydrateLedgerFromDisk(
  turnId: string,
  workspacePath: string,
): Promise<TaskLedger | undefined> {
  if (memoryLedgers.has(turnId)) return memoryLedgers.get(turnId);
  const disk = await loadLedgerFromDisk(workspacePath, turnId);
  if (disk) memoryLedgers.set(turnId, disk);
  return disk ?? undefined;
}

export function createLedger(params: {
  turnId: string;
  chatId: number;
  originalTask: string;
  chatType: "workspace" | "general";
  workspacePath?: string;
  stepDescriptions?: string[];
}): TaskLedger {
  const descs =
    params.stepDescriptions?.filter((d) => d.trim().length > 0) ?? [];
  const steps: TaskStep[] =
    descs.length > 0
      ? descs.map((d, i) => ({
          id: i + 1,
          description: d.trim(),
          status: (i === 0 ? "in_progress" : "pending") as StepStatus,
        }))
      : [
          {
            id: 1,
            description: params.originalTask,
            status: "in_progress" as const,
          },
        ];
  const ledger: TaskLedger = {
    turnId: params.turnId,
    chatId: params.chatId,
    originalTask: params.originalTask,
    chatType: params.chatType,
    workspacePath: params.workspacePath,
    createdAt: Date.now(),
    steps,
    currentStepId: steps[0]?.id ?? 1,
    finishReason: "in_progress",
  };
  memoryLedgers.set(params.turnId, ledger);
  if (params.workspacePath) {
    void persistLedgerToDisk(ledger);
    scheduleLivingPlanSync(params.turnId);
  }
  if (ledger.steps.length > 0) {
    notifyLedgerPlanUiIfRegistered(ledger);
  }
  return ledger;
}

export function formatLedgerForPrompt(ledger: TaskLedger): string {
  const done = ledger.steps.filter((s) => s.status === "done");
  const pending = ledger.steps.filter((s) => s.status === "pending");
  const failed = ledger.steps.filter((s) => s.status === "failed");
  const inProg = ledger.steps.find((s) => s.status === "in_progress");
  const allWritten = [
    ...new Set(ledger.steps.flatMap((s) => s.filesWritten ?? [])),
  ];
  const header = ledger.turnId.startsWith("plan:")
    ? "## Active Plan (from Plan mode)\n"
    : "[Task Progress]\n";
  let out = `${header}Original task: ${ledger.originalTask}\n`;
  if (done.length) {
    out += "Completed steps:\n";
    for (const s of done) {
      out += `- ${s.description}${s.result ? ` → ${s.result.slice(0, 400)}` : ""}\n`;
    }
  }
  if (inProg) {
    out += `Current step: ${inProg.description}\n`;
    if (inProg.result?.trim()) {
      out += `Notes: ${inProg.result.slice(0, 600)}\n`;
    }
  }
  if (pending.length) {
    out += "Remaining steps:\n";
    for (const s of pending) {
      out += `- ${s.description}\n`;
    }
  }
  if (failed.length) {
    out += "Failed steps:\n";
    for (const s of failed) {
      out += `- ${s.description}\n`;
    }
  }
  if (allWritten.length) {
    out += `Files written so far: ${allWritten.join(", ")}\n`;
  }
  const remaining = getRemainingSteps(ledger);
  if (remaining.length > 0) {
    out += `\n\n${buildPendingStepsContinuationPrompt(remaining)}\n\nDo not stop until all steps are complete.`;
  }
  return out.trim();
}

export function getLedgerStateString(turnId: string): string | undefined {
  const L = memoryLedgers.get(turnId);
  if (!L) return undefined;
  return formatLedgerForPrompt(L);
}

export async function cancelLedger(turnId: string): Promise<void> {
  const L = memoryLedgers.get(turnId);
  if (L) {
    L.finishReason = "cancelled";
    if (L.workspacePath) await persistLedgerToDisk(L);
  }
  memoryLedgers.delete(turnId);
}

export function markLedgerStreamComplete(turnId: string): void {
  const L = memoryLedgers.get(turnId);
  if (!L) return;
  if (L.finishReason === "cancelled") return;
  const allDone = L.steps.every(
    (s) => s.status === "done" || s.status === "failed",
  );
  if (allDone) {
    L.finishReason = "complete";
    if (L.workspacePath) void persistLedgerToDisk(L);
    scheduleLivingPlanSync(turnId);
    notifyLedgerPlanUiIfRegistered(L);
    if (L.chatType === "general") memoryLedgers.delete(turnId);
    else if (turnId.startsWith("plan:")) clearLedger(turnId);
  }
}

/** Record tool outcome on the active step; multi-step ledgers advance one step per tool. */
export function recordToolOnLedger(
  turnId: string,
  meta: {
    toolName: string;
    summary: string;
    filesRead?: string[];
    filesWritten?: string[];
  },
): void {
  const L = memoryLedgers.get(turnId);
  if (!L || L.finishReason === "cancelled") return;
  const step =
    L.steps.find((s) => s.id === L.currentStepId && s.status === "in_progress") ??
    L.steps.find((s) => s.status === "in_progress") ??
    L.steps[L.steps.length - 1];
  if (!step) return;
  if (meta.filesRead?.length) {
    step.filesRead = [
      ...new Set([...(step.filesRead ?? []), ...meta.filesRead]),
    ];
  }
  if (meta.filesWritten?.length) {
    step.filesWritten = [
      ...new Set([...(step.filesWritten ?? []), ...meta.filesWritten]),
    ];
  }
  const line = `${meta.toolName}: ${meta.summary.slice(0, 300)}`;
  step.result = step.result ? `${step.result}\n${line}` : line;

  if (L.steps.length > 1) {
    step.status = "done";
    step.completedAt = Date.now();
    const next = L.steps.find((s) => s.status === "pending");
    if (next) {
      next.status = "in_progress";
      L.currentStepId = next.id;
    }
  } else if (
    L.steps.length === 1 &&
    step.status === "in_progress" &&
    LEDGER_COMPLETION_TOOLS.has(meta.toolName)
  ) {
    step.status = "done";
    step.completedAt = Date.now();
  }

  markLedgerStreamComplete(turnId);
  if (L.workspacePath) void persistLedgerToDisk(L);
  scheduleLivingPlanSync(turnId);
  const afterMark = memoryLedgers.get(turnId);
  if (afterMark) notifyLedgerPlanUiIfRegistered(afterMark);
}

/** Flatten Architect structured plan JSON to step description lines (shared with plan-ledger mirror). */
export function descriptionsFromArchitectPayload(payload: unknown): string[] | null {
  const parsed = ArchitectPlanPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { phases } = parsed.data;
  const descriptions: string[] = [];
  for (const ph of phases) {
    const title = ph.title?.trim() ?? ph.id;
    for (const t of ph.tasks) {
      const line = t.trim();
      if (!line) continue;
      descriptions.push(title ? `[${title}] ${line}` : line);
    }
  }
  return descriptions.length > 0 ? descriptions : null;
}

/**
 * After Architect delegation: replace a single coarse step with plan phases/tasks from structured payload.
 * Returns true if the ledger was re-seeded.
 */
export async function seedLedgerFromHandoff(
  turnId: string,
  payload: unknown,
): Promise<boolean> {
  const descriptions = descriptionsFromArchitectPayload(payload);
  if (!descriptions) return false;
  await setLedgerSteps(turnId, descriptions);
  return true;
}

/**
 * Record delegation sub-agent tool lines on the active step without advancing the step
 * (the parent turn advances once per completed delegation via `advanceLedgerAfterDelegation`).
 */
export function recordDelegationToolOnLedger(
  turnId: string,
  meta: {
    toolName: string;
    summary: string;
    filesRead?: string[];
    filesWritten?: string[];
  },
): void {
  const L = memoryLedgers.get(turnId);
  if (!L || L.finishReason === "cancelled") return;
  const step =
    L.steps.find((s) => s.id === L.currentStepId && s.status === "in_progress") ??
    L.steps.find((s) => s.status === "in_progress") ??
    L.steps[L.steps.length - 1];
  if (!step) return;
  if (meta.filesRead?.length) {
    step.filesRead = [
      ...new Set([...(step.filesRead ?? []), ...meta.filesRead]),
    ];
  }
  if (meta.filesWritten?.length) {
    step.filesWritten = [
      ...new Set([...(step.filesWritten ?? []), ...meta.filesWritten]),
    ];
  }
  const line = `${meta.toolName}: ${meta.summary.slice(0, 300)}`;
  step.result = step.result ? `${step.result}\n${line}` : line;
  if (L.workspacePath) void persistLedgerToDisk(L);
}

/**
 * After a successful `delegate_to_agent` handoff: for multi-step ledgers, mark the active step
 * done and promote the next pending step. Single-step ledgers only append delegation summary to notes.
 */
export function advanceLedgerAfterDelegation(
  turnId: string,
  resultSummary: string,
): void {
  const L = memoryLedgers.get(turnId);
  if (!L || L.finishReason === "cancelled") return;
  const summary = resultSummary.slice(0, 2000);
  if (L.steps.length <= 1) {
    const step = L.steps[0];
    if (step?.status === "in_progress") {
      const line = `[delegation] ${summary}`;
      step.result = step.result ? `${step.result}\n${line}` : line;
    }
    if (L.workspacePath) void persistLedgerToDisk(L);
    return;
  }
  const step =
    L.steps.find((s) => s.id === L.currentStepId && s.status === "in_progress") ??
    L.steps.find((s) => s.status === "in_progress");
  if (!step) return;
  step.status = "done";
  step.completedAt = Date.now();
  step.result = summary;
  const next = L.steps.find((s) => s.status === "pending");
  if (next) {
    next.status = "in_progress";
    L.currentStepId = next.id;
  }
  if (L.workspacePath) void persistLedgerToDisk(L);
  scheduleLivingPlanSync(turnId);
  notifyLedgerPlanUiIfRegistered(L);
}

/** Replace ledger steps from plan parsing (e.g. ATLARIX_PLAN.md numbered tasks). */
export async function setLedgerSteps(
  turnId: string,
  descriptions: string[],
  options?: { archive?: boolean },
): Promise<void> {
  const L = memoryLedgers.get(turnId);
  if (!L || descriptions.length === 0) return;
  const trimmed = descriptions.map((d) => d.trim()).filter((d) => d.length > 0);
  if (trimmed.length === 0) return;
  const doArchive = options?.archive !== false;
  if (doArchive && L.workspacePath) {
    const { archiveCurrentPlan } = await import("./plan-sync");
    await archiveCurrentPlan(L.workspacePath);
  }
  L.steps = trimmed.map((d, i) => ({
    id: i + 1,
    description: d,
    status: (i === 0 ? "in_progress" : "pending") as StepStatus,
  }));
  L.currentStepId = L.steps[0]!.id;
  if (L.workspacePath) void persistLedgerToDisk(L);
  scheduleLivingPlanSync(turnId);
  notifyLedgerPlanUiIfRegistered(L);
}

export function appendLedgerFilesWritten(
  turnId: string,
  paths: string[],
): void {
  if (paths.length === 0) return;
  const L = memoryLedgers.get(turnId);
  if (!L) return;
  const step =
    L.steps.find((s) => s.status === "in_progress") ?? L.steps[L.steps.length - 1];
  if (!step) return;
  step.filesWritten = [...new Set([...(step.filesWritten ?? []), ...paths])];
  if (L.workspacePath) void persistLedgerToDisk(L);
  scheduleLivingPlanSync(turnId);
}
