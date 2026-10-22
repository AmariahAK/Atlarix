/**
 * Permission Interceptor
 * ======================
 * Intercepts tool results, buffers permission requests, and executes approved operations.
 * Modeled after StackSense's PermissionHandler + Claude Code's blocking approval.
 *
 * v0.9.1 Update: Added async waitForApproval() blocking mechanism
 */

import { noteTurn } from "@/lib/analytics/turn-stats";
import * as fs from "fs/promises";
import * as fsSync from "node:fs";
import * as path from "path";
import { assertRealpathContained as assertRealpathContainedShared } from "@/lib/security/realpath-contain";
import { recordMutationOutcome } from "@/lib/agent/mutation-verify";
import {
  computeLineDelta,
  recordEditStatsSafely,
} from "@/lib/stats/edit-stats";
import { wrapUntrustedData } from "@/lib/streaming/untrusted-data";
import log from "electron-log";
import { EventEmitter } from "events";
import { BrowserWindow } from "electron";
import {
  PermissionRequest,
  PermissionResult,
  FileOperationPreview,
  CommandOperationPreview,
  BatchPlanPreview,
  AutomationOperationPreview,
  McpServerOperationPreview,
  parsePermissionRequest,
} from "../../../lib/tools/permissions/schema";
import {
  runShellCommandStreaming,
  CommandResult,
  type SandboxRunOptions,
} from "../../utils/runShellCommand";
import type { ChildProcess } from "child_process";
import { resolvePathUnderWorkspace } from "../../utils/safeWorkspaceRelativePath";
import {
  listSandboxWritablePaths,
  upsertSandboxWritablePath,
} from "@/lib/file-permissions-store";
import {
  parseSandboxDenialsFromOutput,
  sandboxEscalationDecision,
  sandboxGrantPath,
} from "@/lib/sandbox/wrap-command";
import { describeSandboxFailureContext } from "@/lib/sandbox/sandbox-failure-context";
import { formatCommandOutput, resolveMaxOutputBytes } from "./command-output";
import { targetPathsForOperation } from "./operation-targets";
import { refreshPlanLedgerFromWrittenFile } from "@/lib/tasks/plan-ledger-from-file";
import { captureSnapshotAcrossRoots } from "../../../lib/snapshot/snapshot-manager";
import { appendLedgerFilesWritten } from "../../../lib/tasks/task-ledger";
import {
  isAlwaysAutoApproveAtlarixRelativePath,
  isAtlarixPlanRelativePath,
} from "../../../lib/tasks/plan-sync";
import { FileUploadsState } from "../../utils/file_uploads_state";
import { readSettings } from "../../../main/settings";
import { resolveEffectiveWorkMode, isReadOnlyWorkMode } from "@/lib/work-mode";
import type { WorkMode } from "@/lib/schemas";
import {
  openTerminalInstance,
  resolveScopeKey,
  appendAgentCommandOutput,
} from "../../../lib/terminal-instance-store";
import { isAgentMemoryDisabled, memoryDirFor } from "@/lib/agent-memory";
import { isAutoWritablePath } from "@/lib/auto-writable-paths";
import { agentScratchDirFor } from "@/lib/agent-scratch";
import { isOutsidePathOnlySystemScope } from "@/lib/system-scope-commands";
import { injectAgentGitIdentity } from "../../utils/git_author";
import { hasConfiguredGitIdentity } from "../../utils/git_utils";

const logger = log.scope("permission-interceptor");

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

// v14.7: the Item-5 grace-then-park window was removed — approvals now BLOCK the
// turn mid-loop until the user decides (see waitForApproval below).

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Three-state result of waiting on a decision (Item 5). */
export type WaitOutcome = "approved" | "rejected" | "undecided";

interface PendingApproval {
  resolve: (outcome: WaitOutcome) => void;
  /** v14.7: undefined for the indefinite mid-loop block (no grace timeout). */
  timeout?: NodeJS.Timeout;
  createdAt: number;
}

interface BufferedOperation {
  id: string;
  request: PermissionRequest;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  createdAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
// INTERCEPTOR CLASS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Operations whose execution result carries a file diff the model is told about.
 * Module-level so the CAPTURE site (executeOperation) and the READ site
 * (getExecutionResult) cannot drift apart.
 */
const RESULT_BEARING_FILE_OPS = new Set([
  "write_file",
  "write_multiple_files",
  "edit_file",
  "replace_code",
  "insert_code",
  "delete_lines",
]);

/** What `getExecutionResult` reports for an executed file write. */
interface FileOpExecutionResult {
  success: true;
  path: string;
  operation: "create" | "delete" | "update";
  oldContent: string;
  newContent: string;
  verified?: boolean;
  output?: string;
}

/**
 * Revert restores from a git snapshot taken before each write. Without Git
 * (a fresh Windows) every capture fails and Revert is never offered: say so
 * once per run, in the chat that was writing, rather than only in the log.
 */
let revertNeedsGitNoted = false;
async function noteRevertNeedsGit(chatId: number): Promise<void> {
  if (revertNeedsGitNoted) return;
  const { isGitAvailable, GIT_NOT_INSTALLED_MESSAGE } = await import(
    "@/ipc/utils/system_git_exec"
  );
  if (revertNeedsGitNoted || (await isGitAvailable())) return;
  revertNeedsGitNoted = true;
  const payload = {
    id: "revert-needs-git",
    type: "background",
    label: "Revert is off: Git isn't installed.",
    detail: GIT_NOT_INSTALLED_MESSAGE,
    status: "done",
    timestamp: Date.now(),
    chatId,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("chat:activity", payload);
  }
}

/** Test seam: the notice is once per process. */
export function _resetRevertNeedsGitNoticeForTests(): void {
  revertNeedsGitNoted = false;
}

export class PermissionInterceptor extends EventEmitter {
  /** Map of operation ID to pending permission request */
  private pendingOperations: Map<string, BufferedOperation> = new Map();

  /** Map of operation ID to pending approval promise */
  private pendingApprovals: Map<string, PendingApproval> = new Map();

  /** Map of operation ID to command execution results */
  private commandOutputs: Map<string, CommandResult> = new Map();
  /** Why an operation the user APPROVED then failed (not a command: those keep their output). */
  private failureReasons: Map<string, string> = new Map();

  /** Per run_command operation: max UTF-8 bytes for formatted output (survives pendingOperations eviction). */
  private commandOutputMaxBytes: Map<string, number> = new Map();

  /**
   * Per file-write operation: the execution result, kept so it SURVIVES
   * `pendingOperations` eviction — the same reason `commandOutputs` exists.
   *
   * THE BUG THIS FIXES (observed live 2026-09-11, op_1789120127239_9w4wgisfg).
   * `executeAllOperations` — the path "Approve rest of turn" takes — deletes
   * every operation it ran from `pendingOperations`. The build branch then
   * called `getExecutionResult(operationId)`, which found nothing and returned
   * `{ success: false, error: "Operation ... not found" }`. Its caller
   * (`jsonAfterSuccessfulExec`) had already decided the write succeeded, so it
   * reported **"Successfully wrote README.md, added: 0, removed: 0"** — a
   * success carrying an empty diff, because `oldContent`/`newContent` came back
   * undefined and the LCS of "" against "" is zero hunks.
   *
   * The model correctly disbelieved it and spent a turn running `git diff` to
   * learn whether its own edit had landed. Three quieter things broke with it:
   * `path` went undefined, the fuzzy-match `notice` never reached the model,
   * and `verified` was lost — so an unverified write took the falsy branch and
   * CLEARED its self-review flag instead of recording it.
   *
   * Commands already had exactly this fix (`commandOutputs`); writes never got it.
   */
  private fileOpResults: Map<string, FileOpExecutionResult> = new Map();

  /**
   * Drop the write results once this interceptor's turn is over. Each holds
   * the file's old AND new content, kept so a result asked for after execution
   * still answers; nothing asks once the next turn has its own interceptor, and
   * a long Build turn's worth of whole-file copies otherwise stays in memory for
   * as long as the chat is open. Commands are left alone: a background command
   * started in this turn can still finish and report through it.
   */
  releaseSettledWrites(): void {
    this.fileOpResults.clear();
  }

  /** Monotonic id suffix for mid-run sandbox-escalation approval requests. */
  private sandboxEscalationSeq = 0;

  /** Workspace path for resolving file paths */
  private workspacePath: string;

  /** Workspace ID (session tracking, snapshots, blast radius) */
  private workspaceId: number | null = null;

  /**
   * Assistant / turn id used as `.atlarix/snapshots/<turnId>/` directory name.
   * When unset, `maybeCaptureWorkspaceSnapshot` is a no-op (no manifest or .bak files).
   * Ephemeral Ask chats omit this (see chat_stream_handlers: PermissionInterceptor gets no turn id),
   * so those sessions never write workspace snapshots. Build uses a stable stream turn id even for
   * ephemeral workspaces, so pre-write capture can still run there.
   */
  private snapshotTurnId: string | null = null;

  /** Active chat id for plan-ledger attribution (Build / Ask stream). */
  private activeChatId: number;

  /**
   * The model driving THIS turn, for attributing what it writes (edit stats).
   *
   * Per-turn for the same reason `turnWorkMode` and `turnAbortSignal` are: one
   * interceptor is built per turn and never reused, so a model recorded here
   * cannot outlive the turn that chose it, and another window switching models
   * mid-turn cannot retag work this turn is still doing.
   *
   * `name` is stored RESOLVED by the caller — for Atlarix Core that means the
   * vendor model the tier currently routes to, never `core-N`.
   */
  private turnModel: { provider: string; name: string } | null = null;

  /** When run_command uses an absolute cwd outside workspace, we allow file ops under that path for this session */
  private allowedRoots: Set<string> = new Set();

  /**
   * This project's agent-memory directory, or null when memory is off.
   * Resolved but NOT created — see `ensureMemoryDirForWrite`.
   */
  private memoryDir: string | null = null;

  /** One mkdir per interceptor at most. */
  private memoryDirEnsured = false;
  private scratchDirEnsured = false;

  /**
   * The user pressed "Allow all this turn" — approve everything for the rest of
   * THIS turn without asking again.
   *
   * Lives on the interceptor precisely because the interceptor is per-turn and
   * is never reused: the blanket therefore expires when the turn does, with no
   * expiry logic to get wrong and nothing to clean up.
   *
   * This exists because a one-shot drain did not match what people meant by it.
   * "Approve all" cleared the queue, the model issued its next command, and the
   * prompt came straight back — so on a research turn (`curl`, then `python3`,
   * then `jq`, each of which trips the danger gate on its FIRST TOKEN) it had to
   * be pressed once per command. The durable alternative, "Always allow", is
   * keyed per danger pattern, so for those it means "this exact command" and
   * never generalises either.
   *
   * Deliberately NOT a saved rule. It ends with the turn, so it cannot become a
   * standing grant nobody remembers agreeing to.
   */
  private turnBlanketApproved = false;

  /**
   * The work mode of the TURN that built this interceptor — not the app's current
   * one.
   *
   * A new interceptor is constructed for every turn (build-branch / ask-branch),
   * so the turn's mode is a fixed property of the instance. It must NOT be
   * re-derived from `readSettings()`: `workModePreference` / `selectedChatMode`
   * are a single app-wide value, so a SECOND WINDOW opening in Ask mode used to
   * flip this window's in-flight Build turn to a read-only sandbox mid-command —
   * `git` then failed with "cannot lock ref 'HEAD' … Operation not permitted"
   * while the UI still said Build.
   *
   * `undefined` only for callers that predate this (tests); those fall back to
   * the old global read so behaviour is unchanged for them.
   */
  private turnWorkMode: WorkMode | null = null;

  /**
   * The abort signal of the TURN that built this interceptor.
   *
   * Exists so an approval the interceptor is blocked on can be unwound by Stop.
   * The two ESCALATION lanes below call `waitForApproval` from inside
   * `executeOperation`, several frames beneath the branch runner that owns the
   * AbortController — so unlike every other caller they had no signal to pass and
   * blocked forever.
   *
   * Observed: an `edit_file` into the agent-memory directory (outside the
   * workspace) raised the folder-grant card and blocked for 10 minutes. Stop did
   * nothing, because nothing was listening; clicking the card afterwards STILL
   * completed the write, because the promise had never been cancellable. The turn
   * looked hung and was in fact waiting, unstoppably.
   *
   * Same lifetime reasoning as `turnWorkMode`: one interceptor per turn, never
   * reused, so the signal cannot outlive the turn it belongs to.
   */
  private turnAbortSignal: AbortSignal | null = null;

  /**
   * Nobody can answer a card this turn: a headless `atlarix run` or an
   * automation. Their auto-approvers answer the cards a tool call raises; the
   * ones raised HERE (a sandbox or folder grant) reach app windows alone, and the
   * wait has no timeout, so the run blocked until killed (QA A3, 2026-10-22).
   * Unattended, those two are denied before they are raised, with a reason the
   * model reads. Tool-call cards still wait for the auto-approver: denying them
   * here too told the model `git init` was refused (QA, 2026-10-22).
   */
  private unattended = false;

  setUnattended(on: boolean): void {
    this.unattended = on;
  }

  constructor(
    workspacePath: string,
    workspaceId?: number,
    snapshotTurnId?: string | number,
    activeChatId?: number,
    turnWorkMode?: WorkMode,
    turnAbortSignal?: AbortSignal,
    turnModel?: { provider: string; name: string } | null,
  ) {
    super();
    this.workspacePath = workspacePath;
    this.workspaceId = workspaceId ?? null;
    this.activeChatId = activeChatId ?? 0;
    this.turnWorkMode = turnWorkMode ?? null;
    this.turnAbortSignal = turnAbortSignal ?? null;
    this.turnModel = turnModel ?? null;
    if (snapshotTurnId !== undefined && snapshotTurnId !== null) {
      this.snapshotTurnId = String(snapshotTurnId);
    }
    // This project's agent-memory directory is writable.
    //
    // It lives OUTSIDE the repo by design (~/.atlarix/projects/<slug>/memory/)
    // so notes are per-developer and never committed — but that put it on the
    // wrong side of the outside-workspace check below, so every note the agent
    // tried to write threw "Path is outside workspace". The prompt handed it an
    // absolute path and told it to write there, and the harness hard-refused:
    // memory was readable and un-writable, which is exactly the kind of thing
    // the harness must not do silently.
    //
    // Scoped to THIS workspace's slug, so a turn cannot reach another project's
    // notes, and the ordinary approval gate fires — the user sees the diff like
    // any other write. (That last part was NOT true when this was first written:
    // the memory path's relative form contains `/.atlarix/`, which the blanket
    // `.atlarix/**` allowance in shouldAlwaysAutoApprove matched, so notes were
    // landing silently. Fixed there by refusing to auto-approve anything whose
    // relative path leaves the workspace.)
    try {
      if (workspacePath && !isAgentMemoryDisabled()) {
        // NOT created here. The directory is made on the first write that
        // actually targets it (`ensureMemoryDirForWrite`).
        //
        // It used to be `mkdirSync`'d in this constructor, because the
        // realpath containment check below cannot resolve a directory that
        // does not exist and would refuse the first note. But an interceptor
        // is constructed for every workspace path the app ever sees —
        // including the temp workspaces the test suite builds — so this line
        // created 435 empty `…atlarix-grant-XXXXXX…` directories in the
        // developer's real ~/.atlarix/projects. "An empty directory costs
        // nothing" was true per directory and wrong in aggregate: it made the
        // project count meaningless and wrote into a user's home from tests.
        this.memoryDir = path.resolve(memoryDirFor(workspacePath));
        this.allowedRoots.add(this.memoryDir);
      }
    } catch {
      // Memory is optional; never block a turn on it.
    }
    // This workspace's SCRATCH directory is writable for file tools too.
    //
    // The runtime identity block hands the agent `<tmp>/atlarix-scratch/<slug>`
    // by name and tells it to put temp files there rather than guessing at
    // `/tmp`. But `edit_file` resolves through `resolvePathWithinWorkspace`,
    // which refused anything outside the workspace or an allowed root — so the
    // prompt gave the model a path and the file tool threw "Path is outside
    // workspace" when it used it, leaving shelling out as the only way to write
    // a file it had just been told to write.
    //
    // THE SCRATCH DIRECTORY, NOT THE TEMP ROOT. Granting all of `os.tmpdir()`
    // was the first attempt and it was too broad in a way the tests caught
    // immediately: the suite builds its workspaces under the temp root, so
    // "outside the workspace" stopped meaning anything — the outside-folder
    // escalation never fired and a symlink escaping a granted folder landed
    // inside an allowed root. On macOS that root is `/var/folders`, which is
    // every app's cache, not a scratch area. Per-workspace, like the memory
    // directory, so one project's turn cannot reach another's scratch either.
    try {
      if (workspacePath) {
        this.allowedRoots.add(path.resolve(agentScratchDirFor(workspacePath)));
      }
    } catch {
      /* scratch is optional; never block a turn on it */
    }
    // snapshotTurnId left null → disk snapshots disabled for this interceptor instance (e.g. Ask + ephemeral).
    logger.log(
      `[PermissionInterceptor] Initialized for workspace: ${workspacePath} (id: ${workspaceId}, turn: ${this.snapshotTurnId ?? "none"}, chat: ${this.activeChatId})`,
    );
  }

  /**
   * Approve everything for the remainder of this turn (see `turnBlanketApproved`).
   * One-way: there is no un-set, because the turn ending is the un-set.
   */
  approveRestOfTurn(): void {
    this.turnBlanketApproved = true;
    logger.log(
      `[approveRestOfTurn] chat ${this.activeChatId}: approvals suppressed for the rest of this turn`,
    );
  }

  /** Whether the rest-of-turn blanket is active (for logging / tests). */
  isTurnBlanketApproved(): boolean {
    return this.turnBlanketApproved;
  }

  /**
   * File / batch file operations under `.atlarix/` or `.atlarixignore` auto-approve without user prompt.
   */
  shouldAlwaysAutoApprove(request: PermissionRequest): boolean {
    // "Allow all this turn" covers everything the turn asks for afterwards —
    // including dangerous commands, which is the whole point: on the turns
    // where this button gets pressed, the danger gate is what is firing.
    if (this.turnBlanketApproved) return true;
    const checkPath = (filePath: string): boolean => {
      try {
        // Places the harness ITSELF pointed the agent at: the OS temp roots and
        // this workspace's memory directory. The runtime identity block tells
        // the model to write its notes to one and its temp files to the other,
        // and then this gate asked about every write to both — a card per note,
        // for a path the prompt supplied.
        //
        // Checked BEFORE the `../` guard below, because both legitimately live
        // outside the workspace. That is safe only because the check is
        // CONTAINMENT against this workspace's own resolved memory root, not a
        // substring — the substring version is precisely what let
        // `../other-repo/.atlarix/hooks/hooks.json` through.
        if (
          path.isAbsolute(filePath) &&
          isAutoWritablePath(
            path.resolve(filePath),
            this.memoryDir,
            this.workspacePath ? agentScratchDirFor(this.workspacePath) : null,
          )
        ) {
          return true;
        }
        const rel = this.toWorkspaceRelativePosix(filePath);
        // NOTHING outside the workspace is ever blanket auto-approved,
        // whatever it is named.
        //
        // The `.atlarix/**` allowance below is scoped to THIS project's
        // own agent files, but it matched on the substring `/.atlarix/`
        // — and a path outside the workspace renders as `../…`, so
        // `../other-repo/.atlarix/hooks/hooks.json` matched too. A
        // granted directory would therefore have carried silent write
        // access to ANOTHER project's agent config. The same bug already
        // applied to the agent-memory directory, whose relative form is
        // `../../../../.atlarix/projects/<slug>/memory/…`: those writes
        // were landing with no approval card at all, contradicting the
        // interceptor's own claim that the ordinary gate still fires.
        if (rel.startsWith("../") || rel === "..") return false;
        return isAlwaysAutoApproveAtlarixRelativePath(rel);
      } catch {
        return false;
      }
    };

    // v8.0.1: User-attached file uploads auto-approve (user consented by attaching)
    const checkPreApprovedPath = (filePath: string): boolean => {
      try {
        return FileUploadsState.getInstance().isPreApprovedPath(filePath);
      } catch {
        return false;
      }
    };

    switch (request.operation) {
      case "edit_file":
      case "delete_file": {
        const preview = request.preview as FileOperationPreview;
        if (preview?.path && checkPreApprovedPath(preview.path)) return true;
        return Boolean(preview?.path && checkPath(preview.path));
      }
      case "rename_file": {
        const preview = request.preview as FileOperationPreview;
        if (preview?.toPath && checkPreApprovedPath(preview.toPath))
          return true;
        return Boolean(
          preview?.fromPath &&
            preview?.toPath &&
            checkPath(preview.fromPath) &&
            checkPath(preview.toPath),
        );
      }
      case "batch_plan": {
        const batch = request.preview as BatchPlanPreview;
        if (!batch?.operations?.length) return false;
        for (const op of batch.operations) {
          if (
            "command" in op &&
            typeof (op as CommandOperationPreview).command === "string"
          ) {
            return false;
          }
          const fp = op as FileOperationPreview;
          if (!fp?.path || !checkPath(fp.path)) return false;
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** After writing ATLARIX_PLAN.md: refresh workspace `plan:<id>` ledger without re-archiving. */
  /**
   * Emit operation status to all windows for queue UI updates
   */
  private emitStatus(
    operationId: string,
    status: "pending" | "queued" | "running" | "completed" | "failed",
    progress?: number,
    duration?: number,
    error?: string,
  ): void {
    const payload = { operationId, status, progress, duration, error };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("operation-status", payload);
    }
    logger.log(
      `[emitStatus] ${operationId} -> ${status}${error ? ` (${error})` : ""}`,
    );
  }

  /**
   * Set workspace ID (if not known at construction time)
   */
  setWorkspaceId(id: number): void {
    this.workspaceId = id;
  }

  /**
   * Update workspace path and ID (e.g. after create_workspace in same turn).
   * Ensures subsequent run_command/write_file in this session use the new project root.
   */
  setWorkspace(path: string, id?: number): void {
    this.workspacePath = path;
    if (id != null) this.workspaceId = id;
    logger.log(
      `[PermissionInterceptor] Workspace updated to: ${path} (id: ${id})`,
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DETECTION & PARSING
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Check if a tool result is a permission request (object or string)
   */
  isPermissionRequest(result: unknown): boolean {
    // Structured object format (the contract — v12 0.4-C1: the legacy
    // "__PERMISSION_REQUIRED__" text fallback was deleted; its last main-
    // process producer, run_tests, now emits the structured envelope).
    if (typeof result === "object" && result !== null) {
      return (result as any).__permission_required === true;
    }

    // JSON-string form (structured envelope serialized by the registry).
    if (typeof result === "string") {
      try {
        const parsed = JSON.parse(result);
        return parsed.__permission_required === true;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Parse and validate a permission request from tool result
   */
  parsePermissionRequest(result: unknown): PermissionRequest | null {
    // Object format (the contract)
    if (
      typeof result === "object" &&
      result !== null &&
      (result as any).__permission_required
    ) {
      logger.log("[parsePermissionRequest] Parsed object format");
      return result as PermissionRequest;
    }

    // JSON-string form
    if (typeof result === "string") {
      const parsed = parsePermissionRequest(result);
      if (parsed) {
        logger.log("[parsePermissionRequest] Parsed JSON string format");
        return parsed;
      }
    }

    return null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // BUFFERING
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Generate unique operation ID
   */
  generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Buffer an operation for batch approval
   * @param silent When true, do not emit permission-request (autonomous auto-approve path).
   */
  bufferOperation(
    operationId: string,
    request: PermissionRequest,
    silent = false,
  ): void {
    const operation: BufferedOperation = {
      id: operationId,
      request,
      status: "pending",
      createdAt: Date.now(),
    };

    this.pendingOperations.set(operationId, operation);

    // Enhanced logging for debugging
    logger.log("[Permission Request Buffered]", {
      id: operationId,
      operation: request.operation,
      path: (request.preview as any)?.path || "N/A",
      timestamp: new Date().toISOString(),
    });

    const silentOut = silent || this.shouldAlwaysAutoApprove(request);
    noteTurn(this.activeChatId || undefined, silentOut ? "approvals_auto" : "approvals_asked");
    if (!silentOut) {
      // Emit event for frontend to pick up
      this.emit("permission-request", {
        operationId,
        request,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Get all pending operations for UI display
   */
  getPendingOperations(): Array<{ id: string; request: PermissionRequest }> {
    return Array.from(this.pendingOperations.values())
      .filter((op) => op.status === "pending")
      .map((op) => ({ id: op.id, request: op.request }));
  }

  /**
   * Check if there are pending operations
   */
  hasPendingOperations(): boolean {
    return Array.from(this.pendingOperations.values()).some(
      (op) => op.status === "pending",
    );
  }

  /**
   * Get count of all executed operations (for agentic loop tracking)
   */
  getExecutedOperationsCount(): number {
    return Array.from(this.pendingOperations.values()).filter(
      (op) => op.status === "executed" || op.status === "failed",
    ).length;
  }

  /**
   * Get count of all operations (any status)
   */
  getAllOperationsCount(): number {
    return this.pendingOperations.size;
  }

  /**
   * Clear all pending operations
   */
  clearPendingOperations(): void {
    // Clear any waiting approvals
    for (const [, approval] of this.pendingApprovals) {
      clearTimeout(approval.timeout);
      approval.resolve("rejected"); // Auto-reject on clear
    }
    this.pendingApprovals.clear();
    this.pendingOperations.clear();
    logger.log("[PermissionInterceptor] Cleared all pending operations");
  }

  // ════════════════════════════════════════════════════════════════════════════
  // BLOCKING APPROVAL MECHANISM (NEW in v0.9.1)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * v14.7 — BLOCK the turn mid-loop until the user decides (Claude-Code model).
   * The wait is **indefinite** (no grace/park): the tool's `execute` stays
   * suspended, so the turn remains one live `streamText` round — the Stop button
   * shows, the model can't emit a premature "done", and on decision the loop
   * continues with the real result. Safe re: connections: the upstream model
   * response already closed at `finish`, so nothing is held open during the wait
   * (see plan Step 0). Resolved by `executeOperation`/`rejectOperation` →
   * `resolveApproval`. Cancelled by the turn's abort signal (Stop), which
   * rejects with the abort reason so `streamText` unwinds cleanly.
   *
   * NOTE: this is the HUMAN-approval gate only — machine waits (sub-agents,
   * `run_command`) keep their own timeouts and are NOT made unbounded here.
   */
  async waitForApproval(
    operationId: string,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<WaitOutcome> {
    return new Promise((resolve, reject) => {
      const abortSignal = opts?.abortSignal;
      const onAbort = () => {
        this.pendingApprovals.delete(operationId);
        reject(
          abortSignal?.reason instanceof Error
            ? abortSignal.reason
            : new DOMException("Approval wait aborted", "AbortError"),
        );
      };
      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
      this.pendingApprovals.set(operationId, {
        resolve: (outcome) => {
          if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
        // No grace timeout — indefinite block.
        createdAt: Date.now(),
      });
      logger.log(
        `[waitForApproval] Blocking (indefinite) for user response on ${operationId}`,
      );
    });
  }

  /**
   * Resolve an approval (called when user clicks Approve/Reject). No-op if the
   * grace window already expired (the op parked) — the decision is then handled
   * by the IPC handler executing/rejecting the still-pending op directly.
   */
  private resolveApproval(operationId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(operationId);
    if (pending) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.resolve(approved ? "approved" : "rejected");
      this.pendingApprovals.delete(operationId);
      logger.log(
        `[resolveApproval] ${operationId} -> ${approved ? "APPROVED" : "REJECTED"}`,
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // EXECUTION
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Execute a single approved operation.
   * Called when user clicks Approve button.
   */
  async executeOperation(
    operationId: string,
    options?: { overrideContent?: string },
  ): Promise<PermissionResult> {
    const operation = this.pendingOperations.get(operationId);
    if (!operation) {
      return {
        operationId,
        approved: false,
        error: `Operation ${operationId} not found`,
      };
    }
    // Decided once. A rule just saved can approve the operations already
    // waiting (applyNewRuleToPendingOperations), and a second answer to the
    // same card, still on screen, ran the write again (owner, CLI, 2026-10-19:
    // src/index.tsx written twice, two seconds apart).
    if (operation.status !== "pending") {
      return {
        operationId,
        approved: operation.status === "approved" || operation.status === "executed",
        error: `Operation ${operationId} was already ${operation.status}`,
      };
    }

    const request = operation.request;

    // v10 per-hunk approval: the user accepted only some hunks — write the
    // composed partial content instead of the full proposal. Persisted on
    // the preview so result reporting + per-turn revert reflect what was
    // actually written.
    // One entry, because one operation writes content: the surgical names were
    // all folded into `edit_file` in v13.8 and none has had a producer since.
    const CONTENT_WRITE_OPS = new Set(["edit_file"]);
    if (
      typeof options?.overrideContent === "string" &&
      CONTENT_WRITE_OPS.has(request.operation)
    ) {
      const preview = request.preview as FileOperationPreview;
      if (preview && typeof preview === "object") {
        preview.content = options.overrideContent;
        logger.log(
          `[executeOperation] per-hunk override applied for ${operationId} (${request.operation})`,
        );
      }
    }

    // NOTE: Do NOT resolve approval here! We wait until execution completes.
    // This ensures the AI doesn't continue until the command is done.

    try {
      operation.status = "approved";

      // Emit running status for queue UI
      this.emitStatus(operationId, "running");

      // Cross-workspace writes: ask ONCE for the folder, then proceed.
      //
      // This used to throw here — after the user had already read and
      // approved the diff — telling them to re-import the folder as the
      // project. Commands have had escalate-and-grant since v14.15.0; file
      // edits just never got it, so `edit_file`'s own description promising
      // absolute paths "including outside the workspace" was a claim the
      // harness refused to honour.
      await this.ensureOutsideTargetsGranted(
        operationId,
        targetPathsForOperation(request),
      );

      switch (request.operation) {
        case "delete_file":
          await this.executeDeleteFile(request);
          break;
        case "rename_file":
          await this.executeRenameFile(request);
          break;
        case "run_command":
          await this.executeRunCommand(operationId, request);
          break;
        // `edit_file` produces preview.content with the full file, whichever
        // operation the model asked for — create, overwrite or surgical
        // replace — so one executor covers them all.
        case "edit_file":
          await this.executeWriteFile(request);
          break;
        // Parent-aggregated: execute each sub-operation in order (v2.2)
        case "batch_plan":
          await this.executeBatchPlan(operationId, request);
          break;
        case "revert_project_snapshot":
          await this.executeRevertProjectSnapshot(request);
          break;
        case "sandbox_escalation":
          // No execution: approving only unblocks waitForApproval so the
          // originating command can grant the denied path + retry (see
          // maybeEscalateSandboxDenial). resolveApproval(true) fires below.
          break;
        case "automation_write":
          await this.executeAutomationWrite(request);
          break;
        case "mcp_server_write":
          await this.executeMcpServerWrite(request);
          break;
        default:
          throw new Error(`Unknown operation: ${request.operation}`);
      }

      // Mark as executed
      operation.status = "executed";

      // Emit completed status - frontend will clear all errors (todo approach)
      this.emitStatus(operationId, "completed");

      logger.log(
        `[executeOperation] Executed ${operationId}: ${request.operation}`,
      );

      // Edit-file verifier (B1): the write landed. Clear any prior mutation
      // failure for the turn so the completion gate (mutation-verify) won't
      // hold the model back. Failures are recorded in the catch below.
      if (this.snapshotTurnId && CONTENT_WRITE_OPS.has(request.operation)) {
        recordMutationOutcome(this.snapshotTurnId, true);
      }

      const preview = request.preview as FileOperationPreview;

      // Edit stats: count what LANDED, from the same LCS diff the approval card
      // drew. `preview.content` already carries the per-hunk override applied at
      // the top of this method, so a partial acceptance counts the hunks the user
      // kept rather than the ones the model proposed.
      //
      // Recorded here, in the single place every accepted write passes through —
      // user-approved, silently auto-approved, per-hunk, sub-agent, and the ask
      // branch all reach this method. Counting at the tool instead would miss
      // every path that does not return through it, and counting only where a
      // card was shown would miss the auto-approved ones entirely.
      if (
        this.workspaceId != null &&
        this.turnModel &&
        CONTENT_WRITE_OPS.has(request.operation) &&
        preview?.path
      ) {
        recordEditStatsSafely({
          workspaceId: this.workspaceId,
          provider: this.turnModel.provider,
          modelId: this.turnModel.name,
          delta: computeLineDelta(
            preview.type,
            preview.oldContent,
            preview.content,
          ),
        });
      }

      // Snapshot the result while the preview still exists. `executeAllOperations`
      // evicts this operation the moment its batch finishes, and the build branch
      // asks for the result AFTER that — see the `fileOpResults` field comment.
      if (preview?.path && RESULT_BEARING_FILE_OPS.has(request.operation)) {
        this.fileOpResults.set(operationId, {
          success: true,
          path: preview.path,
          operation:
            preview.type === "create"
              ? "create"
              : preview.type === "delete"
                ? "delete"
                : "update",
          oldContent: preview.oldContent ?? "",
          newContent: preview.content ?? "",
          ...(typeof preview.verified === "boolean"
            ? { verified: preview.verified }
            : {}),
          ...(preview.notice ? { output: preview.notice } : {}),
        });
      }

      // v13.8: write_file folded into edit_file (operation:"write"), so the
      // ATLARIX_PLAN.md / .atlarixignore detection keys off any content write.
      if (this.workspaceId && CONTENT_WRITE_OPS.has(request.operation)) {
        // Always a single preview now — the array shape belonged to
        // `write_multiple_files`, which no tool emits. Kept as a list so
        // the loop below reads the same.
        const previews = preview?.path ? [preview as FileOperationPreview] : [];
        let sawPlanWrite = false;
        let sawIgnoreWrite = false;
        for (const p of previews) {
          const norm = String(p.path || "").replace(/\\/g, "/");
          if (!norm) continue;
          if (
            norm === ".atlarix/ATLARIX_PLAN.md" ||
            norm.endsWith("/.atlarix/ATLARIX_PLAN.md") ||
            norm === "ATLARIX_PLAN.md" ||
            norm.endsWith("/ATLARIX_PLAN.md")
          ) {
            sawPlanWrite = true;
          }
          if (
            norm === ".atlarix/.atlarixignore" ||
            norm.endsWith("/.atlarix/.atlarixignore") ||
            norm === ".atlarixignore" ||
            norm.endsWith("/.atlarixignore")
          ) {
            sawIgnoreWrite = true;
          }
        }
        if (sawPlanWrite) {
          const { recordPlanUpdateSnapshot } = await import(
            "@/lib/project-memory/service"
          );
          void recordPlanUpdateSnapshot(this.workspaceId, this.workspacePath);
        }
        // Pass 7: Blueprint cache no longer exists; .atlarixignore writes don't need invalidation here.
        void sawIgnoreWrite;
      }

      // Queue timeline capture for file operations
      // Resolve approval AFTER execution completes
      // This is the key fix - AI now waits for command to finish
      this.resolveApproval(operationId, true);

      return {
        operationId,
        approved: true,
        executedAt: Date.now(),
      };
    } catch (error) {
      // Mark as failed
      operation.status = "failed";

      // Emit failed status for queue UI
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.emitStatus(
        operationId,
        "failed",
        undefined,
        undefined,
        errorMessage,
      );

      logger.error(`[executeOperation] Failed ${operationId}:`, error);
      this.failureReasons.set(operationId, errorMessage);

      // Edit-file verifier (B1): the write genuinely failed — record it so
      // the completion gate refuses to finish on an unapplied edit
      // (bounded; the model is nudged to fix and retry first).
      if (this.snapshotTurnId && CONTENT_WRITE_OPS.has(request.operation)) {
        recordMutationOutcome(
          this.snapshotTurnId,
          false,
          `Your ${request.operation} did not apply (${errorMessage}). Re-check the file/path and retry the edit before finishing.`,
        );
      }

      // Resolve with false on error so AI knows it failed
      this.resolveApproval(operationId, false);

      return {
        operationId,
        approved: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the execution result for an operation (for returning to AI)
   * For run_command, includes formatted terminal output with smart truncation
   */
  getExecutionResult(operationId: string): {
    success: boolean;
    path?: string;
    error?: string;
    output?: string;
    exitCode?: number;
    duration?: number;
    operation?: string;
    oldContent?: string;
    newContent?: string;
    command?: string;
    verified?: boolean;
    automationId?: string;
    /** Allowed by the user, then the operation itself failed (not a refusal). */
    approvedButFailed?: boolean;
  } {
    const operation = this.pendingOperations.get(operationId);

    // CRITICAL FIX: If operation was deleted from pendingOperations
    // (which happens after executeAllOperations), still check commandOutputs
    // This ensures command failures are correctly identified vs user rejections
    if (!operation) {
      const cmdResult = this.commandOutputs.get(operationId);
      if (cmdResult) {
        const maxB = this.getMaxOutputBytesForCommand(operationId, null);
        // Command was executed - return result with exitCode
        const base = {
          success: cmdResult.success,
          // Model-facing only (no UI consumer of getExecutionResult):
          // command output is untrusted — frame it as data. Harness control
          // messages (e.g. a background-job start notice) are trusted → not wrapped.
          output: cmdResult.harnessMessage
            ? formatCommandOutput(cmdResult.stdout, cmdResult.stderr, maxB)
            : wrapUntrustedData(
                "command-output",
                formatCommandOutput(cmdResult.stdout, cmdResult.stderr, maxB),
              ),
          exitCode: cmdResult.exitCode,
          error: cmdResult.success
            ? undefined
            : cmdResult.stderr.slice(0, 500) || "Command failed",
        };
        // We do not have the command string here, so we cannot attach the
        // Blueprint suggestion in this code path. The hot path (operation
        // still in pendingOperations) handles git-commit detection below.
        return base;
      }
      // Truly not found - this is a user rejection or timeout
      // Evicted by executeAllOperations, but it DID run — report the write we
      // captured then, rather than a not-found the caller reads as an empty diff.
      const fileResult = this.fileOpResults.get(operationId);
      if (fileResult) return fileResult;
      return { success: false, error: `Operation ${operationId} not found` };
    }

    const maxOutBytes = this.getMaxOutputBytesForCommand(
      operationId,
      operation,
    );

    if (operation.status === "executed") {
      // Include command output for run_command operations
      if (operation.request.operation === "run_command") {
        const cmdResult = this.commandOutputs.get(operationId);
        if (cmdResult) {
          // Carry the command string so the chat thread can render a
          // PERSISTENT command+output+exit card (not just transient output).
          const cmdPreview = operation.request.preview as
            | { command?: string }
            | undefined;
          const base = {
            success: cmdResult.success,
            command:
              typeof cmdPreview?.command === "string"
                ? cmdPreview.command
                : undefined,
            // Untrusted command output framed as data so the MODEL treats it
            // as data, not instructions. This same string is persisted and
            // reaches the UI; the chat display path strips the envelope
            // (stripUntrustedDataEnvelope) so the user sees only the output.
            // A harness control message (bg-job start notice) is trusted → not wrapped.
            output: cmdResult.harnessMessage
              ? formatCommandOutput(
                  cmdResult.stdout,
                  cmdResult.stderr,
                  maxOutBytes,
                )
              : wrapUntrustedData(
                  "command-output",
                  formatCommandOutput(
                    cmdResult.stdout,
                    cmdResult.stderr,
                    maxOutBytes,
                  ),
                ),
            exitCode: cmdResult.exitCode,
            error: cmdResult.success
              ? undefined
              : cmdResult.stderr.slice(0, 500),
          };
          return base;
        }
      }

      const preview = operation.request.preview as
        | FileOperationPreview
        | undefined;
      const path = preview?.path;
      if (path && RESULT_BEARING_FILE_OPS.has(operation.request.operation)) {
        const opType =
          preview.type === "create"
            ? "create"
            : preview.type === "delete"
              ? "delete"
              : "update";
        return {
          success: true,
          path,
          operation: opType,
          oldContent: preview.oldContent ?? "",
          newContent: preview.content ?? "",
          // Did the on-disk bytes match what we intended (set in
          // executeWriteFile)? Consumed by the self-review gate.
          ...(typeof preview.verified === "boolean"
            ? { verified: preview.verified }
            : {}),
          // Audit note (e.g. edit_file fuzzy-match drift) — flows to
          // the model via jsonAfterSuccessfulExec's `output`.
          ...(preview.notice ? { output: preview.notice } : {}),
        };
      }
      if (path) {
        return { success: true, path };
      }
      // A created automation's id only exists after approval, so hand it
      // back here — the tool's own description tells the model to run the
      // automation next, and name is not a key (two may share one).
      if (operation.request.operation === "mcp_server_write") {
        const note = (operation.request.preview as { resultNote?: string }).resultNote;
        return { success: true, ...(note ? { output: note } : {}) };
      }
      if (operation.request.operation === "automation_write") {
        const autoPreview = operation.request
          .preview as AutomationOperationPreview;
        return {
          success: true,
          ...(autoPreview.automationId
            ? { automationId: autoPreview.automationId }
            : {}),
        };
      }
      return { success: true };
    }

    if (operation.status === "rejected") {
      return {
        success: false,
        error:
          "Permission denied by user. Do not retry the same operation — adjust the approach, or use ask_user to clarify what the user wants instead.",
      };
    }

    if (operation.status === "failed") {
      // Include command error output if available
      const cmdResult = this.commandOutputs.get(operationId);
      if (cmdResult) {
        return {
          success: false,
          output: formatCommandOutput(
            cmdResult.stdout,
            cmdResult.stderr,
            maxOutBytes,
          ),
          exitCode: cmdResult.exitCode,
          error: cmdResult.stderr.slice(0, 500) || "Command failed",
        };
      }
      // Approved, then failed: say so. Reported as "Permission denied by user",
      // the agent told the user they had refused what they had allowed (QA F1).
      const reason = this.failureReasons.get(operationId);
      return {
        success: false,
        approvedButFailed: true,
        error: reason ? `The user approved this, but it failed: ${reason}` : "The user approved this, but it failed.",
      };
    }

    return { success: false, error: `Operation status: ${operation.status}` };
  }

  private getMaxOutputBytesForCommand(
    operationId: string,
    operation: BufferedOperation | null | undefined,
  ): number {
    const fromMap = this.commandOutputMaxBytes.get(operationId);
    if (fromMap != null) return fromMap;
    if (operation?.request?.operation === "run_command") {
      const p = operation.request.preview as CommandOperationPreview;
      return resolveMaxOutputBytes(
        (p as { max_output_bytes?: number }).max_output_bytes,
      );
    }
    return resolveMaxOutputBytes(undefined);
  }

  /**
   * Execute all pending operations (batch approval)
   * All operations now run sequentially to ensure proper ordering.
   * Commands wait for completion before the next operation starts.
   */
  async executeAllOperations(): Promise<PermissionResult[]> {
    const results: PermissionResult[] = [];
    const operationsToExecute: [string, BufferedOperation][] = [];

    // Filter to only pending operations (not already executed/rejected)
    for (const [operationId, operation] of this.pendingOperations) {
      if (operation.status === "pending") {
        operationsToExecute.push([operationId, operation]);
      }
    }

    if (operationsToExecute.length === 0) {
      logger.log("[executeAllOperations] No pending operations to execute");
      return results;
    }

    logger.log(
      `[executeAllOperations] Processing ${operationsToExecute.length} pending operations sequentially`,
    );

    // Execute all operations sequentially - this ensures commands complete before next starts
    for (const [operationId] of operationsToExecute) {
      const result = await this.executeOperation(operationId);
      results.push(result);

      // Log progress for long-running command sequences
      logger.log(
        `[executeAllOperations] Completed ${result.operationId}: ${result.approved ? "success" : "failed"}`,
      );
    }

    // Clear executed operations from pending map
    for (const [operationId] of operationsToExecute) {
      this.pendingOperations.delete(operationId);
    }

    logger.log(
      `[executeAllOperations] Completed all ${operationsToExecute.length} operations`,
    );

    return results;
  }

  /**
   * Reject a single operation.
   * Called when user clicks Reject button.
   */
  rejectOperation(operationId: string): PermissionResult {
    const operation = this.pendingOperations.get(operationId);
    if (!operation) {
      return {
        operationId,
        approved: false,
        error: `Operation ${operationId} not found`,
      };
    }

    // Resolve the waiting promise with false (unblocks chat stream)
    this.resolveApproval(operationId, false);

    operation.status = "rejected";
    logger.log(
      `[rejectOperation] Rejected ${operationId}: ${operation.request.operation}`,
    );

    return {
      operationId,
      approved: false,
    };
  }

  /**
   * Reject all pending operations
   */
  rejectAllOperations(): PermissionResult[] {
    const results: PermissionResult[] = [];

    for (const [operationId] of this.pendingOperations) {
      results.push(this.rejectOperation(operationId));
    }

    return results;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FILE OPERATIONS
  // ════════════════════════════════════════════════════════════════════════════

  /** Absolute targets a file operation is about to touch (empty for non-file ops). */
  /**
   * For every target outside the workspace, ask the user once for its PARENT
   * DIRECTORY and persist the grant. Throws if they decline.
   *
   * Directory granularity (not per file) is the whole point — it is what every
   * comparable harness does, and per-file prompting was the actual complaint.
   * The grant lands in the same store the command sandbox reads, so one answer
   * covers both lanes.
   */
  private async ensureOutsideTargetsGranted(
    operationId: string,
    targets: readonly string[],
  ): Promise<void> {
    if (targets.length === 0) return;

    const workspaceReal = path.resolve(this.workspacePath);
    const isOutside = (abs: string): boolean => {
      const rel = path.relative(workspaceReal, abs);
      return rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel));
    };
    const alreadyGranted = (abs: string): boolean =>
      this.writableRoots().some((root) => {
        const rel = path.relative(root, abs);
        return !rel.startsWith("..") && !path.isAbsolute(rel);
      });

    // De-duplicate by grant directory so a 12-file batch in one folder asks once.
    const needed = new Map<string, string>();
    for (const raw of targets) {
      if (!path.isAbsolute(raw)) continue;
      const abs = path.resolve(raw);
      if (!isOutside(abs) || alreadyGranted(abs)) continue;
      // A DIRECTORY target (a command's cwd) is granted as itself; a FILE
      // target is granted via its parent so sibling files in the same folder
      // do not each raise their own prompt. `sandboxGrantPath` handles the
      // broad-root case, narrowing to the exact path rather than handing
      // over all of `$HOME`.
      let isDir = false;
      try {
        isDir = fsSync.statSync(abs).isDirectory();
      } catch {
        // Doesn't exist yet — a file about to be created. Parent it is.
      }
      const grantPath = isDir ? abs : sandboxGrantPath(abs);
      if (!needed.has(grantPath)) needed.set(grantPath, abs);
    }
    if (needed.size === 0) return;

    for (const [grantPath, example] of needed) {
      if (this.unattended) {
        throw new Error(
          `Write to ${example} declined — ${grantPath} is outside this workspace, and no one is here to approve it (unattended run).`,
        );
      }
      const escalationId = `${operationId}:dir:${++this.sandboxEscalationSeq}`;
      this.bufferOperation(escalationId, {
        __permission_required: true,
        operation: "sandbox_escalation",
        preview: {
          kind: "file",
          deniedPath: example,
          grantPath,
          description: `Give Atlarix write access to ${grantPath} for this workspace?`,
          // Automations already hard-deny on systemScope, naming
          // "outside-workspace write" as the reason — so an unattended
          // run can never grant itself a new folder.
          systemScope: true,
        },
      } as unknown as PermissionRequest);

      let outcome: WaitOutcome;
      try {
        // Pass the TURN's signal so Stop can unwind this wait. Without it
        // the promise was uncancellable: pressing Stop did nothing, and a
        // click ten minutes later still landed the write.
        outcome = await this.waitForApproval(escalationId, {
          abortSignal: this.turnAbortSignal ?? undefined,
        });
      } catch {
        this.pendingOperations.delete(escalationId);
        throw new Error(`Write to ${example} cancelled.`);
      }
      this.pendingOperations.delete(escalationId);
      if (outcome !== "approved") {
        throw new Error(
          `Write to ${example} declined — ${grantPath} is outside this workspace and was not granted.`,
        );
      }
      if (this.workspaceId != null) {
        upsertSandboxWritablePath(this.workspaceId, grantPath);
      } else {
        // No workspace row to persist against (ephemeral/headless): keep
        // the grant for this session only rather than dropping it.
        this.allowedRoots.add(grantPath);
      }
    }
  }

  /**
   * Resolve a file path so it is under this.workspacePath or under an allowed root (from run_command absolute cwd).
   * - Relative paths: joined with workspacePath (current behavior).
   * - Absolute paths: allowed if inside workspacePath or inside any allowedRoot; otherwise throws.
   */
  private resolvePathWithinWorkspace(filePath: string): string {
    const normalizedWorkspace = path.resolve(this.workspacePath);
    let resolved: string;
    if (!path.isAbsolute(filePath)) {
      resolved = resolvePathUnderWorkspace(this.workspacePath, filePath);
    } else {
      resolved = path.resolve(filePath);
      const relativeToWorkspace = path.relative(normalizedWorkspace, resolved);
      const inWorkspace =
        !relativeToWorkspace.startsWith("..") &&
        !path.isAbsolute(relativeToWorkspace);
      const inAllowedRoot = this.writableRoots().some((root) => {
        const relativeToRoot = path.relative(root, resolved);
        return (
          !relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot)
        );
      });
      if (!inWorkspace && !inAllowedRoot) {
        throw new Error(
          `Path is outside workspace: ${filePath}. Grant this folder from Settings → Workflow, or the agent can ask for it when it needs one.`,
        );
      }
    }
    // The memory directory is created on demand, right before the containment
    // check that needs it to exist (it realpaths every allowed root and SKIPS
    // the ones it cannot resolve, which would silently refuse the first note).
    this.ensureMemoryDirForWrite(resolved);
    this.ensureScratchDirForWrite(resolved);
    // A9/M-2: the string containment above is symlink-blind. Verify the REAL
    // target (resolving symlinks in the path) still lands inside the real
    // workspace/allowed roots — else a symlink committed into the repo could
    // point edit_file/write_file/delete at `~/.zshrc` while the card shows an
    // in-workspace path. Both sides are realpath'd so macOS /var→/private/var
    // symlinks don't cause false rejections; any realpath error fails OPEN.
    this.assertRealpathContained(resolved, normalizedWorkspace, filePath);
    return resolved;
  }

  /**
   * Create this project's memory directory the first time a write actually targets
   * it — never for a workspace whose agent simply never wrote a note.
   */
  /**
   * Create the scratch directory on demand, for the same reason
   * `ensureMemoryDirForWrite` exists: `assertRealpathContained` resolves
   * symlinks on both sides, and a root that does not exist yet cannot be
   * realpath'd — so the FIRST write to it is refused with "Path escapes the
   * workspace", which is both wrong and unactionable.
   *
   * On demand rather than in the constructor, because an interceptor is built
   * for every workspace path the app ever sees — including the temp workspaces
   * the suite creates. Doing this eagerly is what once left 435 empty
   * directories behind (see the memory-dir note in the constructor).
   */
  private ensureScratchDirForWrite(resolved: string): void {
    if (!this.workspacePath || this.scratchDirEnsured) return;
    const scratch = agentScratchDirFor(this.workspacePath);
    const rel = path.relative(scratch, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;
    try {
      fsSync.mkdirSync(scratch, { recursive: true });
      this.scratchDirEnsured = true;
    } catch {
      // Scratch is optional; never block a turn on it.
    }
  }

  private ensureMemoryDirForWrite(resolved: string): void {
    if (!this.memoryDir || this.memoryDirEnsured) return;
    const rel = path.relative(this.memoryDir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;
    try {
      fsSync.mkdirSync(this.memoryDir, { recursive: true });
      this.memoryDirEnsured = true;
    } catch {
      // Memory is optional; never block a turn on it.
    }
  }

  /** Reject when the real (symlink-resolved) target escapes the workspace.
   * Delegates to the shared helper so reads (read_file/glob) and writes agree. */
  private assertRealpathContained(
    resolved: string,
    normalizedWorkspace: string,
    original: string,
  ): void {
    assertRealpathContainedShared(
      resolved,
      normalizedWorkspace,
      this.writableRoots(),
      original,
    );
  }

  /**
   * Every root this workspace may write outside itself: session-scoped roots
   * (agent memory, an approved system-scope `cd`) UNION the user's persisted
   * folder grants.
   *
   * Read from the DB on each call rather than cached at construction, so a
   * revoke in Settings takes effect on the very next write instead of the next
   * session. Only reached when a path already failed the in-workspace check, so
   * the query does not run on ordinary edits.
   *
   * This is also what makes commands and file edits agree: `buildRunCommandSandbox`
   * already feeds the same rows into `extraWritablePaths`. Before this, the two
   * lanes kept disjoint lists — a folder granted to a command was still refused
   * to `edit_file`, and vice versa.
   */
  private writableRoots(): string[] {
    const roots = [...this.allowedRoots];
    if (this.workspaceId == null) return roots;
    try {
      for (const p of listSandboxWritablePaths(this.workspaceId)) {
        if (p) roots.push(path.resolve(p));
      }
    } catch (e) {
      logger.warn(
        `[writable-roots] could not read granted folders: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return roots;
  }

  private toWorkspaceRelativePosix(filePath: string): string {
    const full = this.resolvePathWithinWorkspace(filePath);
    const rel = path.relative(this.workspacePath, full);
    return rel.split(path.sep).join("/");
  }

  /**
   * Capture pre-write file state for this turn, in the workspace AND in any granted
   * folder it touched.
   *
   * Requires `snapshotTurnId` (see field doc). `captureSnapshot` itself does not read
   * chatId; gating is entirely whether the stream passed a turn id into this interceptor.
   *
   * Outside paths used to be DROPPED here, because `captureSnapshot` stages a batch with
   * one `git add -f --` at `cwd = workspace` and git aborts the entire invocation on a
   * path outside its work-tree — so a single granted-folder file in a multi-file write
   * destroyed the pre-write snapshot of every in-workspace file beside it, and Revert
   * then reported success having restored fewer files than it claimed. Dropping them
   * fixed that, at the cost of cross-repo edits silently having no Revert.
   *
   * `captureSnapshotAcrossRoots` removes the cost: each root is snapshotted against its
   * OWN work-tree, so no path is ever outside the repo git is being asked about. Only
   * granted roots are eligible — a path outside every grant could not have been written
   * by an approved edit, and is dropped as before.
   */
  private async maybeCaptureWorkspaceSnapshot(
    relativePaths: string[],
  ): Promise<void> {
    if (!this.snapshotTurnId || !this.workspacePath) return;
    const paths = relativePaths
      .map((p) => p.split(path.sep).join("/"))
      .filter(Boolean);
    if (paths.length === 0) return;
    try {
      await captureSnapshotAcrossRoots({
        workspacePath: this.workspacePath,
        turnId: this.snapshotTurnId,
        paths,
        grantedRoots: this.writableRoots(),
      });
    } catch (e) {
      logger.warn("[maybeCaptureWorkspaceSnapshot] skipped:", e);
    }
    // Asked directly, not from the catch: a capture swallows its own failures
    // (it must never block a write), so a missing Git never reached it and the
    // notice never showed (QA 15.7.1 #3). Cached and once per run.
    void noteRevertNeedsGit(this.activeChatId);
  }

  /**
   * Apply an approved automation change.
   *
   * Nothing reached the database before this point: the tool returned a
   * preview and stopped. A standing job that fires on a schedule while nobody
   * is watching is the case the approval gate exists for — and a deleted
   * automation leaves nothing behind to notice, unlike a file.
   *
   * Routed through `lib/automations/service` so this shares the tier caps, the
   * MCP consent upsert and the scheduler re-arm with the Automations tab. An
   * executor that spoke to the tables directly would drift from the UI, and
   * silently: a missing MCP consent looks just like "the poll found nothing".
   */
  /**
   * Apply an approved MCP server add / edit / delete.
   *
   * Routed through the same handlers the Settings UI uses rather than writing rows
   * here, so the agent path cannot drift from the hand-edited path — the reasoning
   * `executeAutomationWrite` below already applies. Nothing reaches this method until a
   * card has been approved: the tool returns a preview and writes nothing.
   */
  private async executeMcpServerWrite(
    request: PermissionRequest,
  ): Promise<void> {
    const preview = request.preview as McpServerOperationPreview;
    const { db } = await import("@/db");
    const { mcpServers, mcpToolConsents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { mcpManager } = await import("@/ipc/utils/mcp_manager");

    // A web server on the account: the same writes the Settings screen makes.
    if (preview.scope === "account" && preview.accountId && preview.action !== "add") {
      const acct = await import("@/lib/mcp/account-connectors");
      if (preview.action === "delete") {
        const out = await acct.deleteConnector(preview.accountId);
        if (!out.ok) throw new Error(out.error);
        logger.log(`[mcp] removed account server ${preview.serverName}`);
        return;
      }
      const patch = (preview.input ?? {}) as { name?: string; url?: string };
      const out = await acct.updateConnector(preview.accountId, patch);
      if (!out.ok) throw new Error(out.error);
      logger.log(`[mcp] edited account server ${preview.serverName}`);
      return;
    }

    if (preview.action === "delete") {
      if (preview.serverId == null) throw new Error("MCP server id missing");
      await mcpManager.dispose(preview.serverId);
      // Consents are per (server, tool) and meaningless once the server is gone —
      // leaving them would silently pre-approve a FUTURE server that reused the id.
      await db
        .delete(mcpToolConsents)
        .where(eq(mcpToolConsents.serverId, preview.serverId));
      await db.delete(mcpServers).where(eq(mcpServers.id, preview.serverId));
      logger.log(
        `[mcp] deleted server ${preview.serverId} (${preview.serverName})`,
      );
      return;
    }

    const input = preview.input as {
      id?: number;
      name: string;
      transport: string;
      command: string | null;
      args: string[] | null;
      url: string | null;
      envJson: Record<string, string> | null;
      headers?: Record<string, string> | null;
      appId: number;
    } | null;
    if (input == null) {
      throw new Error(
        "MCP server payload missing — nothing was written. Re-issue the manage_mcp_server call.",
      );
    }

    const { encryptEnvForDb } = await import("@/lib/security/db-secrets");
    // `authType` is DERIVED here rather than carried on the preview: it decides whether
    // the runtime prompts for credentials, and a value the model supplied could put a
    // server into a state where it never asks for the key it needs.
    const authType =
      input.envJson && Object.keys(input.envJson).length ? "env" : "none";

    // An http server is added like one pasted in Settings: a public https URL
    // goes on the account, anything else stays in this folder. Switched OFF
    // either way, as below.
    if (preview.action === "add" && input.transport === "http" && input.url) {
      const { addServerFromUrl } = await import("@/lib/mcp/mcp-add");
      const added = await addServerFromUrl(
        input.appId,
        { url: input.url, name: input.name, headers: input.headers ?? undefined },
        { enable: false },
      );
      logger.log(`[mcp] added server ${added.name} (${added.where}), inactive`);
      // It needs the user (a sign-in, a key): the same card a suggestion gets,
      // so they connect it right there and the agent is told.
      const { addMcpSuggestion, waitingOnUserNote } = await import("@/lib/mcp/mcp-suggestions");
      // What the model reads back: it waits on the user (a card), or it is
      // ready to call (a local server turns on at its first use).
      (preview as { resultNote?: string }).resultNote =
        added.needsSignIn || added.needsSecret || added.where === "account"
          ? `"${added.name}" is added. ${waitingOnUserNote(added.name)}`
          : `"${added.name}" is added, switched off; it turns on the first time you call it with mcp_call.`;
      if ((added.needsSignIn || added.needsSecret || added.where === "account") && this.activeChatId != null) {
        addMcpSuggestion({
          chatId: this.activeChatId,
          appId: input.appId,
          server: added.name,
          title: added.name,
          reason: "",
          wait: false,
        });
      }
      return;
    }

    if (preview.action === "add") {
      const [row] = await db
        .insert(mcpServers)
        .values({
          name: input.name,
          transport: input.transport,
          command: input.command || null,
          args: input.args ?? null,
          envJson: encryptEnvForDb(input.envJson ?? null),
          url: input.url || null,
          // Imported servers land INACTIVE. `list_available_mcps` names them without
          // connecting and the first `mcp_call` activates one, so nothing spawns a
          // process until something actually needs it.
          enabled: false,
          scope: "workspace",
          appId: input.appId,
          authType,
        })
        .returning();
      logger.log(`[mcp] added server ${row?.id} (${input.name}), inactive`);
      return;
    }

    if (input.id == null) throw new Error("MCP server id missing for edit");
    await mcpManager.dispose(input.id);
    await db
      .update(mcpServers)
      .set({
        name: input.name,
        transport: input.transport,
        command: input.command || null,
        args: input.args ?? null,
        envJson: encryptEnvForDb(input.envJson ?? null),
        url: input.url || null,
        ...(input.headers !== undefined ? { headersJson: encryptEnvForDb(input.headers ?? null) } : {}),
        authType,
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, input.id));
    logger.log(`[mcp] edited server ${input.id} (${input.name})`);
  }

  private async executeAutomationWrite(
    request: PermissionRequest,
  ): Promise<void> {
    const preview = request.preview as AutomationOperationPreview;
    const svc = await import("@/lib/automations/service");

    if (preview.action === "delete") {
      if (!preview.automationId) throw new Error("Automation id missing");
      await svc.deleteAutomation(preview.automationId);
      logger.log(
        `[automation] deleted ${preview.automationId} (${preview.name})`,
      );
      return;
    }

    const { AutomationInputSchema } = await import("@/lib/automations/types");
    const pending = preview.input;
    if (pending == null) {
      throw new Error(
        "Automation payload missing — nothing was written. Re-issue the automations call.",
      );
    }
    const input = AutomationInputSchema.parse(pending);

    if (preview.action === "create") {
      if (this.workspaceId == null) throw new Error("Workspace required");
      const { id } = await svc.createAutomation(this.workspaceId, input);
      // Stash the new id on the preview so getExecutionResult can report it
      // back to the model (same mechanism as `verified` for file writes).
      // Logging it alone left the model unable to run what it just created.
      preview.automationId = id;
      logger.log(`[automation] created ${id} (${input.name})`);
      return;
    }

    if (!preview.automationId) throw new Error("Automation id missing");
    await svc.updateAutomation(preview.automationId, input);
    logger.log(`[automation] updated ${preview.automationId} (${input.name})`);
  }

  private async executeRevertProjectSnapshot(
    request: PermissionRequest,
  ): Promise<void> {
    const preview = request.preview as {
      snapshotId: number;
      label: string;
      planExcerpt?: string;
    };
    if (this.workspaceId == null) {
      throw new Error("Workspace ID required to revert project snapshot");
    }
    const { applyProjectSnapshotRevert } = await import(
      "@/lib/project-memory/service"
    );
    const result = await applyProjectSnapshotRevert(
      this.workspaceId,
      this.workspacePath,
      preview.snapshotId,
    );
    if (!result.success) {
      throw new Error(result.error || "Revert failed");
    }
    logger.log(`[executeRevertProjectSnapshot] id=${preview.snapshotId}`);
  }

  private async executeWriteFile(request: PermissionRequest): Promise<void> {
    const preview = request.preview as FileOperationPreview;
    await this.maybeCaptureWorkspaceSnapshot([
      this.toWorkspaceRelativePosix(preview.path),
    ]);
    const fullPath = this.resolvePathWithinWorkspace(preview.path);
    const rel = this.toWorkspaceRelativePosix(preview.path);
    if (isAtlarixPlanRelativePath(rel)) {
      const { archiveCurrentPlan } = await import("@/lib/tasks/plan-sync");
      await archiveCurrentPlan(this.workspacePath, rel);
    }
    // Ensure directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Write file
    const intended = preview.content || "";
    await fs.writeFile(fullPath, intended, "utf-8");
    logger.log(`Wrote file: ${fullPath}`);
    // Self-recheck: re-read the bytes we just wrote and confirm they landed.
    // Near-always true, but catches a truncated/failed write that didn't
    // throw. Silent on success; a false here is surfaced ONLY at the
    // end-of-turn task_complete gate (no per-edit token cost).
    try {
      const onDisk = await fs.readFile(fullPath, "utf-8");
      preview.verified = onDisk === intended;
    } catch {
      preview.verified = false;
    }
    if (this.snapshotTurnId) {
      appendLedgerFilesWritten(this.snapshotTurnId, [
        this.toWorkspaceRelativePosix(preview.path),
      ]);
    }
    if (isAtlarixPlanRelativePath(rel)) {
      await refreshPlanLedgerFromWrittenFile({
        workspaceId: this.workspaceId,
        workspacePath: this.workspacePath,
        activeChatId: this.activeChatId,
        fullPath,
        rel,
      });
    }
  }

  private async executeDeleteFile(request: PermissionRequest): Promise<void> {
    const preview = request.preview as FileOperationPreview;
    await this.maybeCaptureWorkspaceSnapshot([
      this.toWorkspaceRelativePosix(preview.path),
    ]);
    const fullPath = this.resolvePathWithinWorkspace(preview.path);

    await fs.unlink(fullPath);
    logger.log(`Deleted file: ${fullPath}`);
  }

  private async executeRenameFile(request: PermissionRequest): Promise<void> {
    const preview = request.preview as FileOperationPreview;
    if (!preview.fromPath || !preview.toPath) {
      throw new Error("Rename operation requires fromPath and toPath");
    }

    await this.maybeCaptureWorkspaceSnapshot([
      this.toWorkspaceRelativePosix(preview.fromPath),
    ]);

    const fromFullPath = this.resolvePathWithinWorkspace(preview.fromPath);
    const toFullPath = this.resolvePathWithinWorkspace(preview.toPath);

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(toFullPath), { recursive: true });

    await fs.rename(fromFullPath, toFullPath);
    logger.log(`Renamed file: ${fromFullPath} → ${toFullPath}`);
  }

  /**
   * Execute diagram update when user approves the AI's request.
   * Calls DiagramManager.regenerateForWorkspace with focus components.
   */
  /**
   * Execute a batch_plan: run each file or command operation in order.
   * Used for parent-aggregated permissions (one approval for full plan).
   */
  private async executeBatchPlan(
    operationId: string,
    request: PermissionRequest,
  ): Promise<void> {
    const batch = request.preview as BatchPlanPreview;
    if (!batch.operations || !Array.isArray(batch.operations)) {
      throw new Error("batch_plan requires preview.operations array");
    }
    for (let i = 0; i < batch.operations.length; i++) {
      const op = batch.operations[i];
      const subId = `${operationId}_${i}`;
      if ("command" in op && typeof op.command === "string") {
        const cmdRequest: PermissionRequest = {
          __permission_required: true,
          operation: "run_command",
          preview: op as CommandOperationPreview,
        };
        await this.executeRunCommand(subId, cmdRequest);
      } else if ("path" in op && typeof op.path === "string") {
        const filePreview = op as FileOperationPreview;
        // "edit_file", not the old "write_file": this label is synthetic — it
        // is built here to choose an executor and is never gated or
        // persisted (`executeWriteFile` reads the preview, never
        // `request.operation`) — but it must still name an operation that
        // exists, or the next reader has to work out whether it is real.
        const opType =
          filePreview.type === "delete"
            ? "delete_file"
            : filePreview.type === "rename"
              ? "rename_file"
              : "edit_file";
        const fileRequest: PermissionRequest = {
          __permission_required: true,
          operation: opType,
          preview: filePreview,
        };
        if (opType === "delete_file") await this.executeDeleteFile(fileRequest);
        else if (opType === "rename_file")
          await this.executeRenameFile(fileRequest);
        else await this.executeWriteFile(fileRequest);
      }
    }
  }

  /**
   * Build the per-OS sandbox options for an agent run_command, or undefined to
   * run unsandboxed. Default ON; disabled by `sandboxRunCommand: false` in
   * settings or the `ATLARIX_DISABLE_SANDBOX` env var. Confines writes to the
   * workspace + caches; the wrapper itself falls back gracefully if the OS tool
   * is missing (unless `enforce`).
   */
  private buildRunCommandSandbox(
    preview?: CommandOperationPreview,
  ): SandboxRunOptions | undefined {
    if (process.env.ATLARIX_DISABLE_SANDBOX === "1") return undefined;
    // A human-approved system-scope command runs UNSANDBOXED — but only when
    // it is system-scope for a reason the sandbox cannot express.
    //
    // An installer (`brew install`, `npm -g`, `sudo …`) writes places nobody
    // can enumerate up front, so the boundary genuinely has to come off. A
    // command that is system-scope ONLY because it touches a path outside the
    // workspace is a different thing entirely: that path is known, the user
    // now grants it explicitly per directory, and it reaches the sandbox via
    // `extraWritablePaths` below. Dropping the sandbox for that case handed an
    // approved outside-path command unrestricted write access to the whole
    // disk — far more than the card asked for. Codex widens `writable_roots`
    // rather than disabling its sandbox; this is the same move.
    if (
      preview?.systemScopeInteractive === true &&
      !(
        preview.command &&
        this.workspacePath &&
        isOutsidePathOnlySystemScope(preview.command, this.workspacePath)
      )
    ) {
      return undefined;
    }
    const settings = readSettings();
    if (settings.sandboxRunCommand === false) return undefined;
    if (!this.workspacePath) return undefined;
    const cfg = settings.sandboxRunCommandConfig;
    // Read-only work modes (Explore/Plan/Review) run commands in a read-only
    // sandbox — the OS denies workspace-source writes, replacing the old
    // command-string mutation classifier. Build/Debug get workspace-write.
    //
    // The mode comes from THIS TURN (`turnWorkMode`, set at construction), not
    // from `readSettings()`. `workModePreference` / `selectedChatMode` are one
    // app-wide value, so re-reading them here let a second window's mode decide
    // this window's sandbox: opening an Explore window mid-turn flipped a Build
    // turn to read-only and `git` died on `.git/HEAD.lock` with the UI still
    // showing Build. Everything else on `settings` below IS genuinely global.
    const workMode =
      this.turnWorkMode ??
      // Legacy callers (tests) that construct without a turn mode.
      resolveEffectiveWorkMode({
        intentMode: settings.intentMode,
        workModePreference: settings.workModePreference,
        selectedChatMode: settings.selectedChatMode ?? "ask",
      });
    // Global settings paths + per-workspace paths the user granted via
    // escalation-on-denial (stored on workspaceFilePermissions/sandbox_path).
    const workspaceGranted =
      this.workspaceId != null
        ? listSandboxWritablePaths(this.workspaceId)
        : [];
    // This workspace's scratch directory, as for the file tools (constructor):
    // the prompt names it as THE place for temp files, so a command writing
    // there (ffmpeg extracting frames to view_image) must not raise a
    // "write outside the sandbox?" card for the agent's own scratch.
    const extraWritablePaths = [
      ...(cfg?.extraWritablePaths ?? []),
      ...workspaceGranted,
      path.resolve(agentScratchDirFor(this.workspacePath)),
    ];
    const readOnly = isReadOnlyWorkMode(workMode);
    return {
      workspacePath: this.workspacePath,
      extraWritablePaths:
        extraWritablePaths.length > 0 ? extraWritablePaths : undefined,
      // Mode-driven read-only deliberately does NOT enforce: that would refuse
      // every Explore/Plan/Review command on a machine with no sandbox, which
      // the graceful-fallback design chose against.
      enforce: cfg?.enforce === true,
      readOnly,
    };
  }

  /**
   * Broadcast a command's output AND record it in the main-side terminal
   * buffer.
   *
   * Both halves in one place deliberately: the buffer used to be filled by the
   * renderer reacting to this event, so any emit site that the panel happened
   * not to be mounted for produced output nobody kept — which is why
   * `background_jobs({operation:"read"})` returned nothing unless the Terminal
   * tab was open. Recording here makes "we said it" and "we kept it" the same
   * action.
   */
  private emitTerminalOutput(payload: {
    operationId: string;
    command: string;
    output: string;
    /**
     * Only what is new since the last emit for this operation.
     *
     * Carried ALONGSIDE `output`, not instead of it, so consumers migrate one at
     * a time. `output` is the accumulated buffer that has always been sent and is
     * what makes this path quadratic: a command emitting N bytes over K chunks
     * pushes ~N·K/2 bytes through every listener. Measured on a 4.9 MB build log,
     * 187 MB re-sent and 218 ms of renderer main-thread parsing per command.
     *
     * Absent on the synthesised terminal events (completed/error), where `output`
     * is the final full text rather than a stream increment — a consumer that
     * appends must treat a missing delta as "nothing new".
     */
    delta?: string;
    status: "running" | "completed" | "error";
    background: boolean;
    exitCode?: number;
    duration?: number;
  }): void {
    try {
      appendAgentCommandOutput(
        resolveScopeKey(this.activeChatId, this.workspaceId),
        {
          operationId: payload.operationId,
          command: payload.command,
          output: payload.output,
          delta: payload.delta,
          status: payload.status,
        },
      );
    } catch (e) {
      // Never let bookkeeping cost the user their output.
      logger.warn("[terminal-buffer] append failed:", e);
    }
    this.emit("terminal-output", payload);
  }

  /** Run one sandboxed attempt of a command, streaming output to `operationId`. */
  private runSandboxedOnce(
    command: string,
    workingDir: string,
    sandbox: SandboxRunOptions,
    operationId: string,
  ): Promise<CommandResult> {
    return runShellCommandStreaming(command, workingDir, {
      sandbox,
      workspaceRoot: this.workspacePath,
      scratchDir: this.workspacePath
        ? path.resolve(agentScratchDirFor(this.workspacePath))
        : undefined,
      // Only the new lines mid-run: every consumer appends `delta`, and sending
      // the whole output so far on each flushed line made a long command's IPC
      // traffic grow with the square of its output. The final result still
      // carries all of it.
      onOutput: ({ deltaStdout, deltaStderr }) => {
        this.emitTerminalOutput({
          operationId,
          command,
          output: "",
          delta: deltaStdout + deltaStderr,
          status: "running" as const,
          background: false,
        });
      },
    })
      .then((r) => r as CommandResult)
      .catch((err) => ({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
        success: false,
      }));
  }

  /**
   * Escalation-on-denial: when a sandboxed command failed on a WRITE the OS
   * denied to a path outside the writable set (e.g. an unlisted toolchain's
   * cache), raise an approval card; if the user grants it, persist the path for
   * this workspace and RE-RUN the command — still sandboxed. Returns the retried
   * result, or null when there is nothing to escalate / the user declined.
   * Bounded so a command that keeps hitting new denials can't loop forever.
   */
  /**
   * A parsed denial that must NOT become a grant card.
   *
   * Two cases. A path already in `granted` was approved earlier in this same
   * run, so a second card would ask for something the user has given. A path
   * INSIDE the workspace cannot be granted at all in a read-only profile —
   * granting your way out of read-only is the one thing that profile exists to
   * prevent.
   *
   * Extracted from the closure in `maybeEscalateSandboxDenial` so that
   * `executeRunCommand` can ask the SAME question when it decides whether the
   * failure was already attributed. It could not before, and that was the bug:
   * `alreadyAttributed` was computed from whether a path had been PARSED, while
   * this predicate decided whether a card was actually RAISED. For an
   * in-workspace denial both were true at once — no card, and no
   * "this ran in READ-ONLY mode" note either, because the note suppresses itself
   * when something else is supposed to be explaining the failure. The model got
   * a bare non-zero exit for a command the prompt had just told it was allowed.
   */
  private isSkippableDenialPath(
    p: string,
    granted: ReadonlySet<string>,
  ): boolean {
    if (granted.has(p)) return true;
    const workspaceReal = this.workspacePath;
    return !!(
      workspaceReal &&
      (p === workspaceReal || p.startsWith(workspaceReal + path.sep))
    );
  }

  private async maybeEscalateSandboxDenial(
    result: CommandResult,
    ctx: {
      commandToRun: string;
      workingDir: string;
      sandboxOpts: SandboxRunOptions | undefined;
      operationId: string;
      /**
       * Re-run the command after a grant.
       *
       * TRUE for a failed command — that is the whole point, and re-running
       * something that already reported failure is safe.
       *
       * FALSE when the command exited 0 while printing a denial (a pipeline
       * swallowing the exit code, e.g. `docker build … | tail -40`). There the
       * command told us it SUCCEEDED, and re-running it could apply its side
       * effects twice. The grant is still persisted and the model is told to
       * re-run — a decision it can make with the command in front of it, which
       * this code cannot.
       */
      allowRetry: boolean;
    },
  ): Promise<CommandResult | null> {
    const { commandToRun, workingDir, sandboxOpts, operationId, allowRetry } =
      ctx;
    if (!sandboxOpts) return null; // no sandbox applied → nothing to grant

    const granted = new Set(sandboxOpts.extraWritablePaths ?? []);
    const isSkippable = (p: string): boolean =>
      this.isSkippableDenialPath(p, granted);

    let queue = parseSandboxDenialsFromOutput(
      `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
    ).filter(
      (d) => !isSkippable(d.grantPath) && userCanReadAndWrite(d.deniedPath),
    );
    if (queue.length === 0) return null;

    if (this.unattended) {
      const first = queue[0]!;
      return {
        ...result,
        stderr:
          `${result.stderr ?? ""}\n\n[atlarix] The command sandbox blocked a write to ` +
          `${first.deniedPath}. No one is here to approve write access to ` +
          `${first.grantPath} (unattended run), so it was denied. Write inside the ` +
          `workspace instead.`,
      };
    }

    let current = sandboxOpts;
    let retried: CommandResult | null = null;
    const MAX_ESCALATIONS = 5;

    for (let i = 0; i < MAX_ESCALATIONS && queue.length > 0; i++) {
      const denial = queue.shift() as { deniedPath: string; grantPath: string };
      if (isSkippable(denial.grantPath)) continue;

      const escalationId = `${operationId}:sbx:${++this.sandboxEscalationSeq}`;
      this.bufferOperation(escalationId, {
        __permission_required: true,
        operation: "sandbox_escalation",
        preview: {
          command: commandToRun,
          deniedPath: denial.deniedPath,
          grantPath: denial.grantPath,
          description: `The command sandbox blocked a write to ${denial.deniedPath}. Grant it write access to ${denial.grantPath} for this workspace and retry?`,
          workingDirectory: workingDir,
          // A folder grant outlives the run, like the `:dir:` card's: an
          // unattended run must never approve one for itself.
          systemScope: true,
        },
      });

      let outcome: WaitOutcome;
      try {
        // Pass the TURN's signal so Stop can unwind this wait. Without it
        // the promise was uncancellable: pressing Stop did nothing, and a
        // click ten minutes later still landed the write.
        outcome = await this.waitForApproval(escalationId, {
          abortSignal: this.turnAbortSignal ?? undefined,
        });
      } catch {
        this.pendingOperations.delete(escalationId);
        return retried; // turn stopped mid-wait
      }
      this.pendingOperations.delete(escalationId);
      if (outcome !== "approved") return retried; // user declined this path

      if (this.workspaceId != null) {
        try {
          upsertSandboxWritablePath(this.workspaceId, denial.grantPath);
        } catch (e) {
          logger.warn(
            `[sandbox-escalation] persist failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      granted.add(denial.grantPath);
      current = {
        ...current,
        extraWritablePaths: [
          ...(current.extraWritablePaths ?? []),
          denial.grantPath,
        ],
      };

      if (!allowRetry) {
        // The command reported SUCCESS while printing a denial. The grant is
        // persisted and applies from the next run; re-running here could
        // duplicate whatever the command already did. Tell the model, in the
        // result it is about to read, and let it decide.
        return {
          ...result,
          stdout:
            `${result.stdout ?? ""}\n\n[atlarix] This command exited 0 but its output ` +
            `reported a denied write to ${denial.deniedPath}. That is the write-confining ` +
            `sandbox, and ${denial.grantPath} is now granted for this workspace — but the ` +
            `command was NOT re-run, because it reported success and re-running it could ` +
            `repeat what it already did. Re-run it if the denial mattered.`,
        };
      }

      retried = await this.runSandboxedOnce(
        commandToRun,
        workingDir,
        current,
        operationId,
      );
      if (retried.success) return retried;

      // Still failing — queue any genuinely NEW denials for the next round.
      const fresh = parseSandboxDenialsFromOutput(
        `${retried.stderr ?? ""}\n${retried.stdout ?? ""}`,
      ).filter((d) => !isSkippable(d.grantPath));
      queue = fresh;
    }
    return retried;
  }

  /**
   * Execute a shell command and store output.
   * Emits 'terminal-output' event for UI updates.
   * Includes timeout protection and progress updates for long-running commands.
   */
  private async executeRunCommand(
    operationId: string,
    request: PermissionRequest,
  ): Promise<void> {
    const preview = request.preview as CommandOperationPreview;
    const maxOutputBytes = Math.min(
      1_000_000,
      Math.max(
        1024,
        Number((preview as { max_output_bytes?: number }).max_output_bytes) ||
          80_000,
      ),
    );
    this.commandOutputMaxBytes.set(operationId, maxOutputBytes);
    const workingDir = preview.workingDirectory
      ? path.isAbsolute(preview.workingDirectory)
        ? preview.workingDirectory
        : path.join(this.workspacePath, preview.workingDirectory)
      : this.workspacePath;

    // DELETED: inferring write scope from a `cd` prefix or an absolute cwd.
    //
    // This regex-matched `^cd <abs>` in the model's own command string and
    // added that directory to `allowedRoots` — an implicit, invisible,
    // permanent-for-the-session grant derived from text the MODEL wrote. No
    // comparable harness does this. Claude Code changes the working directory
    // only through the user's `/cd`, grants roots only through `/add-dir`, and
    // explicitly tells the model a `cd` did not take effect. opencode parses
    // the command and raises its `external_directory` permission for any
    // outside path a `cd`/`rm`/`cp`/… touches. Codex lets the OS sandbox hold
    // the line wherever the command chdir's to. Cursor uses configured
    // workspace roots. In every one of them, a `cd` grants nothing.
    //
    // It is also redundant here twice over: writes are confined by the OS
    // sandbox, and folders outside the workspace now have an explicit,
    // per-directory, revocable grant (Settings → Workflow) that both file
    // edits and commands read. Scope comes from the user, never from a string
    // the model emitted.
    const normalizedWorkspace = path.resolve(this.workspacePath);
    const normalizedWorking = path.resolve(workingDir);

    // An explicit cwd OUTSIDE the workspace goes through the same
    // per-directory grant a cross-repo `edit_file` does: asked once, stored
    // once, revocable in one place. Same answer as opencode's
    // `external_directory` ask and Claude Code's `/add-dir`, reached through
    // the machinery already here rather than a second private path.
    {
      const rel = path.relative(normalizedWorkspace, normalizedWorking);
      if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
        await this.ensureOutsideTargetsGranted(operationId, [
          normalizedWorking,
        ]);
        // Grant recorded (or the user declined and this threw) — the
        // command still runs sandboxed; the granted dir reaches the
        // sandbox through extraWritablePaths in buildRunCommandSandbox.
      }
    }

    // Normalize command: strip "cd /workspace && " or "cd /workspace; " so it runs in workingDir (workspace root).
    // /workspace is a generic path that often doesn't exist on the host; the shell is already in the workspace.
    let commandToRun = preview.command;
    const workspaceCdStrip = /^cd\s+\/workspace(?:\/[^\s;&|]*)?\s*(?:&&|;)\s*/;
    if (workspaceCdStrip.test(preview.command)) {
      commandToRun =
        preview.command.replace(workspaceCdStrip, "").trim() || "true";
      logger.log(
        `[executeRunCommand] Stripped 'cd /workspace' prefix (shell already in workspace); running: ${commandToRun}`,
      );
    }

    // Commits are authored by the user's own git config (Atlarix is credited
    // via the co-author trailer only). Fall back to attributing a bare
    // `git commit` to the agent identity ONLY when the machine has no git
    // identity configured, so the commit still succeeds instead of failing.
    if (
      /\bgit\s+commit\b/.test(commandToRun) &&
      !(await hasConfiguredGitIdentity(workingDir))
    ) {
      const withAgentIdentity = injectAgentGitIdentity(commandToRun);
      if (withAgentIdentity !== commandToRun) {
        logger.log(
          `[executeRunCommand] No git identity configured — injected agent identity into commit command`,
        );
        commandToRun = withAgentIdentity;
      }
    }

    // NOTE: there is no longer a "dangerous command" hard-floor throw here.
    // Danger is handled entirely by the regular permission gate up front
    // (resolveRunCommandPermissionGate): a dangerous command without an
    // explicit always-allow returns `prompt`, so it can only reach this point
    // via a user approval or a user-set always-allow (keyed by its danger
    // pattern). Reaching execute means it was consented to.

    // v14 pt3: NO kill-timeout. A command still running at PROMOTE_AFTER_MS is
    // MOVED to the background (kept alive, tracked, cancellable) — not killed.
    // `background:true` promotes immediately. Dev servers are no longer
    // special-cased; the timer subsumes the old 10s/120s paths so any
    // long-running command (server, watcher, big build) persists.
    const PROMOTE_AFTER_MS = 15_000;
    const startTime = Date.now();
    const explicitBackground =
      (preview as { background?: boolean }).background === true;
    // v14.8.10: opt-in wake condition (wake when the job's output matches).
    const wakeOn = (
      preview as { wake_on?: { pattern: string; regex?: boolean } }
    ).wake_on;
    const allowStalled =
      (preview as { allow_stalled?: boolean }).allow_stalled === true;

    logger.log(
      `[executeRunCommand] Running: ${commandToRun} in ${workingDir}` +
        (explicitBackground
          ? " (background)"
          : ` (promote after ${PROMOTE_AFTER_MS}ms)`),
    );

    const scopeKey = resolveScopeKey(this.activeChatId, this.workspaceId);
    // Foreground commands share one tab; a detached job gets its own so its
    // output doesn't interleave into the session the agent is reading.
    //
    // No longer returns a failure: dropping the 3-agent-terminal cap removed
    // the only way this could refuse. That cap used to reject the fourth
    // terminal and the rejection was discarded here, so the command ran with
    // nowhere to show its output.
    openTerminalInstance(scopeKey, {
      owner: "agent",
      operationId,
      commandHint: commandToRun,
      background: explicitBackground,
    });

    // Audit log for dangerous commands (rm -rf, sudo, etc.)
    if (preview.isDangerous) {
      logger.warn(
        `[DANGEROUS-COMMAND-AUDIT] User approved dangerous command | command="${commandToRun}" | cwd="${workingDir}" | explanation="${preview.dangerExplanation ?? "N/A"}" | timestamp=${new Date().toISOString()}`,
      );
    }
    // Per-OS write-confining sandbox (workspace + caches writable, network on).
    // Applies to agent run_command only — never the user's PTY tabs.
    // An interactively-approved system-scope command MAY run unsandboxed — see
    // the builder for the one case that does not.
    const sandboxOpts = this.buildRunCommandSandbox(preview);

    // Audited from the decision that was actually made, never re-derived.
    //
    // This line used to say "runs unsandboxed" for every system-scope approval,
    // while the builder additionally keeps the sandbox ON when a command is
    // system-scope only by PATH (the boundary stays, the roots widen). Both
    // spellings appeared in one log a millisecond apart, the audit claiming the
    // opposite of what happened — and an audit line is what gets read after an
    // incident. It also now covers the other ways the sandbox legitimately
    // comes off (ATLARIX_DISABLE_SANDBOX, sandboxRunCommand: false, no
    // workspace), which the old wording never described.
    if (preview.systemScopeInteractive === true) {
      const sandboxState = sandboxOpts
        ? "SANDBOXED (writable roots widened for the approved path)"
        : "UNSANDBOXED";
      logger.warn(
        `[SYSTEM-SCOPE-AUDIT] User approved a system-scope command | sandbox=${sandboxState} | command="${commandToRun}" | cwd="${workingDir}" | explanation="${preview.systemScopeExplanation ?? "N/A"}" | timestamp=${new Date().toISOString()}`,
      );
    }

    this.emitTerminalOutput({
      operationId,
      command: commandToRun,
      output: "",
      status: "running" as const,
      background: explicitBackground,
    });

    const chatIdForBg = this.activeChatId;
    const bg = await import("@/lib/agent/background-commands");

    let proc: ChildProcess | null = null;
    let accOutput = "";
    let promoted = false;
    let finished = false;
    let thrownError: Error | null = null;
    let resolveExec: () => void = () => {};
    const execDone = new Promise<void>((res) => {
      resolveExec = res;
    });

    // Move a still-running command to the background: keep the process alive,
    // register it as a cancellable background job, and resolve the model's
    // tool call now with the job id. Its eventual exit is delivered via the
    // background-result path (prepareStep mid-turn / auto-wake when idle).
    const promote = (reason: "explicit" | "timer") => {
      if (promoted || finished) return;
      promoted = true;
      if (chatIdForBg != null) {
        bg.recordBackgroundCommandStart(
          chatIdForBg,
          operationId,
          commandToRun,
          startTime,
          wakeOn,
          allowStalled,
        );
        if (proc) bg.registerBackgroundProc(chatIdForBg, operationId, proc);
        // No longer a foreground (cancel-on-turn-stop) child.
        bg.clearForegroundProc(chatIdForBg, operationId);
        bg.updateBackgroundOutput(chatIdForBg, operationId, accOutput);
      }
      const head =
        reason === "explicit"
          ? `Background command started (job_id: ${operationId}): ${commandToRun}`
          : `Still running after ${PROMOTE_AFTER_MS / 1000}s — moved to the background (job_id: ${operationId}): ${commandToRun}`;
      this.commandOutputs.set(operationId, {
        stdout: `${head}\nYou'll receive its result automatically when it exits — continue other work; do not poll. Check or stop it with background_jobs({operation:"output"|"cancel", job_id:"${operationId}"}).`,
        stderr: "",
        exitCode: 0,
        success: true,
        // Harness control text (not captured output) — don't frame as untrusted.
        harnessMessage: true,
      });
      this.emitTerminalOutput({
        operationId,
        command: commandToRun,
        output: accOutput,
        status: "running" as const,
        background: true,
      });
      resolveExec();
    };

    const promoteTimer = explicitBackground
      ? null
      : setTimeout(() => promote("timer"), PROMOTE_AFTER_MS);

    runShellCommandStreaming(commandToRun, workingDir, {
      sandbox: sandboxOpts,
      workspaceRoot: this.workspacePath,
      scratchDir: this.workspacePath
        ? path.resolve(agentScratchDirFor(this.workspacePath))
        : undefined,
      onSpawn: (p) => {
        proc = p;
        if (promoted && chatIdForBg != null) {
          bg.registerBackgroundProc(chatIdForBg, operationId, p);
        } else if (chatIdForBg != null) {
          // Foreground (blocking) child — track it so a user cancel can
          // actually terminate it (Fix 4). Promotion to background
          // migrates it to the background registry below.
          bg.registerForegroundProc(chatIdForBg, operationId, p);
        }
      },
      onOutput: ({ stdout, stderr, deltaStdout, deltaStderr }) => {
        // `accOutput` stays CUMULATIVE deliberately. It is the sole carrier of
        // pre-promotion output into the background job at `promote()` below, and
        // nothing tests that handoff — leaving it as it was means it cannot
        // regress while the display path migrates to deltas.
        accOutput = stdout + (stderr ? `\n${stderr}` : "");
        if (promoted && chatIdForBg != null) {
          // Delta on the per-chunk path. The promotion handoff below still
          // passes the accumulated buffer, because it is seeding a job that has
          // printed nothing yet and must carry everything from before promotion.
          bg.updateBackgroundOutput(
            chatIdForBg,
            operationId,
            accOutput,
            deltaStdout + deltaStderr,
          );
        }
        this.emitTerminalOutput({
          operationId,
          command: commandToRun,
          output: accOutput,
          delta: deltaStdout + deltaStderr,
          status: "running" as const,
          background: promoted,
        });
      },
    })
      .then(async (resultIn) => {
        let result = resultIn as CommandResult;
        // Stop the promote timer now so the escalation wait below can't be
        // mistaken for a long-running command (denials fail fast anyway).
        finished = true;
        if (promoteTimer) clearTimeout(promoteTimer);
        // Escalation-on-denial: a foreground command that failed on a
        // sandbox WRITE denial may be granted the path + retried (still
        // sandboxed) with the user's approval. Background/promoted runs
        // resolve async and are skipped.
        // The exit code is NOT a reliable signal that nothing was denied. A
        // pipeline reports the LAST command's status, so
        // `docker build … | tail -40` exits 0 while the build died on a
        // sandbox write denial — and gating this whole path on
        // `!result.success` made it unreachable exactly when it was needed
        // (observed 2026-08-29). Ask the output too.
        const escalation = sandboxEscalationDecision(result);
        if (escalation.escalate && !promoted && !explicitBackground) {
          try {
            const retried = await this.maybeEscalateSandboxDenial(result, {
              commandToRun,
              workingDir,
              sandboxOpts,
              operationId,
              allowRetry: escalation.allowRetry,
            });
            if (retried) result = retried;
          } catch (e) {
            logger.warn(
              `[sandbox-escalation] ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        if (chatIdForBg != null)
          bg.clearForegroundProc(chatIdForBg, operationId);
        const duration = Date.now() - startTime;
        this.emitTerminalOutput({
          operationId,
          command: commandToRun,
          output: result.stdout + (result.stderr ? `\n${result.stderr}` : ""),
          status: result.success ? ("completed" as const) : ("error" as const),
          exitCode: result.exitCode,
          duration,
          background: promoted,
        });
        if (promoted) {
          if (chatIdForBg != null) {
            bg.recordBackgroundCommandResult(chatIdForBg, operationId, {
              command: commandToRun,
              exitCode: result.exitCode,
              output:
                result.stdout + (result.stderr ? `\n${result.stderr}` : ""),
              durationMs: duration,
            });
          }
          return;
        }
        this.commandOutputs.set(operationId, result as CommandResult);
        if (result.success) {
          logger.log(
            `[executeRunCommand] Success: ${commandToRun} (${(duration / 1000).toFixed(1)}s)`,
          );
        } else {
          logger.error(
            `[executeRunCommand] Failed: ${commandToRun} (exit ${result.exitCode})`,
          );
          const errDetail = result.stderr
            ? `\n\n${result.stderr.slice(0, 500)}`
            : result.stdout
              ? `\n\n${result.stdout.slice(0, 200)}`
              : "";
          // State that the sandbox was there. Nothing more.
          //
          // By here the escalation pass has run and found no attributable path
          // (`maybeEscalateSandboxDenial` returned null, so `result` is the
          // original failure), which means the model is about to receive a bare
          // non-zero exit with no hint that Atlarix itself constrained the
          // process — a boundary it cannot reason about because nobody told it.
          //
          // Facts only: no attempt to work out whether this failure WAS a
          // denial. The output is already in the error; the model reads it
          // better than a heuristic here could, and a wrong guess would send the
          // user a grant request for an unrelated folder.
          const sandboxNote = describeSandboxFailureContext({
            sandboxed: !!sandboxOpts,
            workingDir,
            writableRoots: [
              ...(sandboxOpts && !sandboxOpts.readOnly
                ? [sandboxOpts.workspacePath]
                : []),
              ...(sandboxOpts?.extraWritablePaths ?? []),
            ],
            ...(sandboxOpts?.readOnly ? { readOnly: true } : {}),
            exitCode: result.exitCode,
            // Attributed means a grant CARD was raised, not that a path was
            // parsed. `maybeEscalateSandboxDenial` drops in-workspace and
            // already-granted paths (`isSkippableDenialPath`), so counting
            // parsed denials suppressed this note in exactly the two cases
            // where nothing else explains the failure.
            alreadyAttributed: parseSandboxDenialsFromOutput(
              `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
            ).some(
              (d) =>
                !this.isSkippableDenialPath(
                  d.grantPath,
                  new Set(sandboxOpts?.extraWritablePaths ?? []),
                ),
            ),
          });
          thrownError = new Error(
            `Command failed with exit code ${result.exitCode}${errDetail}` +
              (sandboxNote ? `\n\n${sandboxNote}` : ""),
          );
        }
        resolveExec();
      })
      .catch((err) => {
        finished = true;
        if (promoteTimer) clearTimeout(promoteTimer);
        if (chatIdForBg != null)
          bg.clearForegroundProc(chatIdForBg, operationId);
        const duration = Date.now() - startTime;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.emitTerminalOutput({
          operationId,
          command: commandToRun,
          output: errMsg,
          status: "error" as const,
          exitCode: -1,
          duration,
          background: promoted,
        });
        if (promoted) {
          if (chatIdForBg != null) {
            bg.recordBackgroundCommandResult(chatIdForBg, operationId, {
              command: commandToRun,
              exitCode: -1,
              output: errMsg,
              durationMs: duration,
            });
          }
          return;
        }
        this.commandOutputs.set(operationId, {
          stdout: "",
          stderr: errMsg,
          exitCode: -1,
          success: false,
        });
        thrownError = new Error(errMsg);
        resolveExec();
      });

    if (explicitBackground) promote("explicit");

    await execDone;
    if (thrownError) throw thrownError;
  }

  /**
   * Get command output for an operation (for returning to AI or UI)
   */
  getCommandOutput(operationId: string): CommandResult | null {
    return this.commandOutputs.get(operationId) || null;
  }
  // CONVERSION TO PROPOSAL FORMAT
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Convert pending operations to CodeProposal format for FileDiffPanel
   */
}

/**
 * Whether the user's OWN permissions allow reading and writing `p` (or, for a
 * path not made yet, its nearest existing folder). The sandbox confines writes
 * only, so a denial on a path the user cannot read or write anyway is the
 * folder's own mode (`find` passing a chmod-000 folder), never a grant to ask
 * for (QA A2, 2026-10-22).
 */
function userCanReadAndWrite(p: string): boolean {
  let at = path.resolve(p);
  for (;;) {
    if (fsSync.existsSync(at)) {
      try {
        fsSync.accessSync(at, fsSync.constants.R_OK | fsSync.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const up = path.dirname(at);
    if (up === at) return false;
    at = up;
  }
}
