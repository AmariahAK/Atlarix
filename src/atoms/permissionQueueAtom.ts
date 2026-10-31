/**
 * Permission Queue Atom
 * =====================
 * Tracks operation status for the permission queue panel.
 * Provides clear status progression: pending → queued → running → completed/failed
 */

import { atom } from "jotai";

export type OperationStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  /** Withdrawn: its turn was stopped (main `endTurn`). */
  | "cancelled";

export interface QueuedOperation {
  id: string;
  /**
   * The chat whose turn asked. The queue is one map for the whole window, and
   * the bar read all of it: a card from one chat showed in every chat (15.11.0).
   */
  chatId?: number;
  operation:
    | "run_command"
    | "edit_file"
    | "delete_file"
    | "rename_file"
    | "batch_plan"
    | "revert_project_snapshot"
    | "sandbox_escalation"
    | "automation_write"
    | "mcp_server_write"
    | "unknown";
  command?: string;
  path?: string;
  /** sandbox_escalation: the path the OS sandbox denied a write to. */
  sandboxDeniedPath?: string;
  /** sandbox_escalation: the folder granted write access on approval. */
  sandboxGrantPath?: string;
  /** sandbox_escalation: which lane asked — a blocked command, or a file edit
   * targeting a folder outside the workspace. Same grant either way. */
  sandboxGrantKind?: "command" | "file";
  /** automation_write: create | update | delete. */
  automationAction?: "create" | "update" | "delete";
  automationName?: string;
  /** Plain-English trigger ("every weekday at 09:00"). */
  automationTrigger?: string;
  automationRunMode?: "notify-only" | "read-only";
  /** Whether finished runs reach the AGENT — the field that governs unattended spend. */
  automationNotifyAgent?: boolean;
  /** update only: "was → now" per changed field. */
  automationChanges?: string[];
  /** Set when an MCP trigger will record standing consent for its tool. */
  automationGrantsMcpConsent?: string;
  /** mcp_server_write: add | edit | delete. */
  mcpAction?: "add" | "edit" | "delete";
  mcpServerName?: string;
  mcpTransport?: "stdio" | "http";
  /** The literal program and argv being approved — rendered verbatim, never summarised. */
  mcpCommand?: string;
  mcpArgs?: string[];
  mcpUrl?: string;
  /** Env variable NAMES only. A value here would put a secret on the card. */
  mcpEnvKeys?: string[];
  mcpHeaderKeys?: string[];
  /** `account`: it goes on every device and the Chrome extension. */
  mcpScope?: "local" | "account";
  /** edit only: "was → now" per changed field. */
  mcpChanges?: string[];
  content?: string; // File content for write_file
  oldContent?: string; // Original content for diff view
  description?: string; // AI-generated change summary
  preview?: string;
  /** For batch_plan: title and summary */
  batchPlanTitle?: string;
  batchPlanSummary?: string;
  batchPlanOperationsCount?: number;
  status: OperationStatus;
  progress?: number; // 0-100 for running commands
  duration?: number; // ms
  error?: string;
  isRecovering?: boolean; // AI is analyzing this failure
  isDangerous?: boolean; // Command is risky (rm -rf, sudo, etc.)
  dangerExplanation?: string; // Plain-English risk explanation
  systemScope?: boolean; // Changes something OUTSIDE the project (install, sudo, outside-workspace write)
  systemScopeExplanation?: string; // Plain-English "what it touches outside the project"
  commandCategory?: string;
  canAlwaysAllow?: boolean;
  isProtectedFile?: boolean;
  isDeleteOrRename?: boolean;
  canAlwaysAllowFile?: boolean;
  canAlwaysAllowDirectory?: boolean;
  canAlwaysAllowFolder?: boolean;
  canAlwaysAllowExtension?: boolean;
  fileParentDir?: string;
  fileExtension?: string;
  timestamp: number;
}

/**
 * Map of operation ID to QueuedOperation
 * This is the source of truth for the permission queue panel
 */
export const permissionQueueAtom = atom<Map<string, QueuedOperation>>(
  new Map(),
);

/**
 * Helper: Get operations by status
 */
export function getOperationsByStatus(
  queue: Map<string, QueuedOperation>,
  status: OperationStatus,
  /** Only this chat's (the bar and the inline cards are per chat). */
  chatId?: number,
): QueuedOperation[] {
  return Array.from(queue.values())
    .filter((op) => op.status === status && (chatId === undefined || op.chatId === chatId))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * A chat's cards still waiting, dropped: its turn ended (the backstop to main's
 * `cancelled` status, for a window that missed it).
 */
export function withoutWaitingForChat(
  queue: Map<string, QueuedOperation>,
  chatId: number,
): Map<string, QueuedOperation> {
  let changed = false;
  const next = new Map(queue);
  for (const [id, op] of queue) {
    if (op.chatId === chatId && (op.status === "pending" || op.status === "queued")) {
      next.delete(id);
      changed = true;
    }
  }
  return changed ? next : queue;
}

/**
 * Helper: Update operation status
 */
export function updateOperationStatus(
  queue: Map<string, QueuedOperation>,
  id: string,
  updates: Partial<QueuedOperation>,
): Map<string, QueuedOperation> {
  const newQueue = new Map(queue);
  const existing = newQueue.get(id);
  if (existing) {
    newQueue.set(id, { ...existing, ...updates });
  }
  return newQueue;
}

/**
 * Helper: Add new operation to queue
 */
export function addOperation(
  queue: Map<string, QueuedOperation>,
  operation: Omit<QueuedOperation, "timestamp">,
): Map<string, QueuedOperation> {
  const newQueue = new Map(queue);
  newQueue.set(operation.id, {
    ...operation,
    timestamp: Date.now(),
  });
  return newQueue;
}

/**
 * Helper: Remove operation from queue
 */
export function removeOperation(
  queue: Map<string, QueuedOperation>,
  id: string,
): Map<string, QueuedOperation> {
  const newQueue = new Map(queue);
  newQueue.delete(id);
  return newQueue;
}
