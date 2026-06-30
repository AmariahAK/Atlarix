/**
 * `task` — the ONE sub-agent tool (v13).
 *
 * Spawns a scoped read-only sub-agent (runSubagent). Issue MULTIPLE task calls
 * in one response for independent scopes — they run concurrently (up to 5 per
 * turn). `background: true` returns immediately with a task id to resume via
 * `task_id`. `subagent_type` may name a user-defined `.atlarix/agents/` agent.
 */

import { randomUUID } from "node:crypto";
import {
  ToolRegistry,
  createParameters,
  stringParam,
  booleanParam,
} from "./registry";
import {
  runSubagent,
  type SubagentActivityEmit,
} from "../agents/run-subagent";
import {
  recordSubagentStart,
  recordSubagentResult,
} from "../agents/subagent-results";
import {
  createSubagentWorktree,
  captureWorktreeDiff,
  removeSubagentWorktree,
  type SubagentWorktree,
} from "../agents/subagent-worktree";

/** Cap the proposed-diff size folded into the task result to protect context. */
const MAX_DIFF_CHARS = 20_000;

/**
 * Wall-clock cap for a background sub-agent so a hung one can't stall the turn.
 * 10 min: a read-only scout on a large repo (or a slower model / slow network)
 * can legitimately run several minutes of grep/read/reason rounds. It's
 * backgrounded (never blocks the main turn) and now cancellable via
 * `task({ task_id, cancel: true })`, so a generous bound is cheap. Override with
 * ATLARIX_SUBAGENT_TIMEOUT_MS.
 */
const DEFAULT_BACKGROUND_TIMEOUT_MS = 10 * 60_000;
function backgroundTimeoutMs(): number {
  const fromEnv = Number(process.env.ATLARIX_SUBAGENT_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_BACKGROUND_TIMEOUT_MS;
}

type TaskRecord = {
  id: string;
  state: "running" | "completed" | "error";
  subagentType: string;
  prompt: string;
  resultText?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** Chat that spawned this task — scopes list/cancel to the caller's session. */
  chatId?: number;
  /** Short label for the list view. */
  description?: string;
  /** Hard-cancel handle (background tasks only). */
  abort?: AbortController;
  /** Set when the main agent cancelled this task — suppresses the auto-wake. */
  cancelled?: boolean;
  /** R3: rolling live-output tail (progress narration + finished tool calls). */
  output?: string;
  /** R3: last time the buffer grew — liveness for the progress view. */
  lastActivityAt?: number;
};

const taskStore = new Map<string, TaskRecord>();

/** R3: cap on a sub-agent's buffered live-output tail (mirrors background commands). */
const SUBAGENT_OUTPUT_TAIL_CAP = 8_000;

/** R3: append a progress chunk to a running task's live-output buffer (tail-capped). */
function appendSubagentOutput(taskId: string, chunk: string): void {
  const rec = taskStore.get(taskId);
  if (!rec || rec.state !== "running") return;
  const next = (rec.output ?? "") + chunk;
  rec.output =
    next.length > SUBAGENT_OUTPUT_TAIL_CAP
      ? "…" + next.slice(-SUBAGENT_OUTPUT_TAIL_CAP)
      : next;
  rec.lastActivityAt = Date.now();
}

/** R3: trimmed tail of a task's live output, for resume/list surfacing. */
function subagentOutputTail(rec: TaskRecord, maxLen: number): string {
  const out = (rec.output ?? "").trim();
  if (!out) return "";
  return out.length > maxLen ? "…" + out.slice(-maxLen) : out;
}

/** Running background sub-agents for a chat (for `task({ list: true })`). */
export function listRunningSubagentTasks(
  chatId: number | undefined,
): Array<{ taskId: string; description: string; elapsedMs: number; lastOutput: string }> {
  const now = Date.now();
  const out: Array<{
    taskId: string;
    description: string;
    elapsedMs: number;
    lastOutput: string;
  }> = [];
  for (const rec of taskStore.values()) {
    if (rec.state !== "running") continue;
    if (chatId != null && rec.chatId !== chatId) continue;
    out.push({
      taskId: rec.id,
      description: rec.description ?? rec.subagentType ?? "(task)",
      elapsedMs: now - rec.startedAt,
      lastOutput: subagentOutputTail(rec, 160).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

/**
 * Hard-cancel a running background sub-agent: abort its model stream (stops
 * spending tokens), mark it cancelled, and suppress the auto-wake (the caller
 * gets the cancel confirmation in-band). No-op (ok:false) if the task is
 * unknown, already finished, or belongs to a different chat.
 */
export function cancelSubagentTask(
  chatId: number | undefined,
  taskId: string,
): { ok: boolean; reason?: string } {
  const rec = taskStore.get(taskId);
  if (!rec) return { ok: false, reason: `Unknown task_id: ${taskId}` };
  if (chatId != null && rec.chatId !== chatId) {
    return { ok: false, reason: `Task ${taskId} belongs to another session` };
  }
  if (rec.state !== "running") {
    return { ok: false, reason: `Task ${taskId} already ${rec.state}` };
  }
  rec.cancelled = true;
  rec.state = "error";
  rec.error = "Cancelled by the main agent.";
  rec.finishedAt = Date.now();
  rec.abort?.abort();
  return { ok: true };
}

/**
 * Cancel EVERY running sub-agent for a chat — called when the user stops the
 * turn so scout tasks stop spending tokens (Fix 4). Returns the count cancelled.
 */
export function cancelAllSubagentTasksForChat(chatId: number): number {
  let n = 0;
  for (const rec of taskStore.values()) {
    if (rec.chatId !== chatId || rec.state !== "running") continue;
    rec.cancelled = true;
    rec.state = "error";
    rec.error = "Cancelled by the user (turn stopped).";
    rec.finishedAt = Date.now();
    try {
      rec.abort?.abort();
    } catch {
      /* already gone */
    }
    n++;
  }
  return n;
}

function taskEnvelope(
  taskId: string,
  state: TaskRecord["state"],
  inner: string,
): string {
  return [
    `<task id="${taskId}" state="${state}">`,
    inner,
    "</task>",
  ].join("\n");
}

ToolRegistry.register({
  name: "task",
  description:
    "Spawn a scoped sub-agent for an independent piece of work (exploring a folder, researching a question, mapping a subsystem, or — with write=true — implementing a change). " +
    "For independent scopes, issue MULTIPLE task calls in ONE response — they run concurrently (up to 5 per turn). " +
    "By default a sub-agent is READ-ONLY. Set write=true to let it implement changes inside an ISOLATED git worktree; its proposed diff comes back for you to review and apply with your own write tools (the workspace is never touched directly). " +
    "Optional subagent_type names a user-defined .atlarix/agents/ agent. " +
    "Set background=true to return immediately with a task id; pass task_id later to collect the result. " +
    "Manage running background sub-agents like background jobs: list=true to see them, or task_id + cancel=true to hard-stop one that's stuck or no longer needed.",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      description: stringParam("Short (3-5 word) description of the task"),
      prompt: stringParam("Full task prompt for the sub-agent"),
      subagent_type: stringParam(
        "Optional: a user-defined agent name from .atlarix/agents/ (omit for the generic scout)",
      ),
      task_id: stringParam(
        "Resume a prior background task (same sub-agent session)",
      ),
      background: booleanParam(
        "When true, run async and return immediately with task id",
      ),
      write: booleanParam(
        "When true, the sub-agent may implement changes inside an isolated git worktree; its proposed diff is returned for you to review and apply (requires a git workspace).",
      ),
      cancel: booleanParam(
        "With task_id: hard-cancel that running background sub-agent (stops its token spend).",
      ),
      list: booleanParam(
        "List your still-running background sub-agents (ids, labels, elapsed time).",
      ),
    },
    // description/prompt are validated in-handler (a NEW task needs them; the
    // task_id / cancel / list control modes do not), so nothing is required.
    [],
  ),
  handler: async (args: {
    description: string;
    prompt: string;
    subagent_type?: string;
    task_id?: string;
    background?: boolean;
    write?: boolean;
    cancel?: boolean;
    list?: boolean;
    workspace?: string;
    workspaceId?: number;
    chatId?: number;
    turnId?: string;
    delegationChatMode?: "build" | "plan" | "ask";
    /** Stream wrapper context (register-delegation-tools). */
    parentDelegationId?: string;
    emitSubagentActivity?: (payload: SubagentActivityEmit) => void;
  }) => {
    const resumeId = args.task_id?.trim();

    // View: list this chat's still-running background sub-agents.
    if (args.list) {
      const running = listRunningSubagentTasks(args.chatId);
      if (!running.length) {
        return "<tasks>No background sub-agents are running.</tasks>";
      }
      const rows = running.map(
        (t) =>
          `<task id="${t.taskId}" elapsed="${Math.round(t.elapsedMs / 1000)}s">${t.description}${t.lastOutput ? ` — ${t.lastOutput}` : ""}</task>`,
      );
      return `<tasks>\n${rows.join("\n")}\n</tasks>`;
    }

    // Cancel: hard-abort a running background sub-agent (stops its token spend).
    if (resumeId && args.cancel) {
      const res = cancelSubagentTask(args.chatId, resumeId);
      return res.ok
        ? `<task id="${resumeId}" state="cancelled"><task_result>Cancelled background sub-agent ${resumeId}; its work was stopped.</task_result></task>`
        : taskEnvelope(resumeId, "error", `<task_error>${res.reason}</task_error>`);
    }

    if (resumeId) {
      const existing = taskStore.get(resumeId);
      if (!existing) {
        return taskEnvelope(
          resumeId,
          "error",
          `<task_error>Unknown task_id: ${resumeId}</task_error>`,
        );
      }
      if (existing.state === "running") {
        const tail = subagentOutputTail(existing, 1_500);
        return taskEnvelope(
          resumeId,
          "running",
          [
            "<summary>Background task still running</summary>",
            "<task_progress>",
            tail || "(no output captured yet)",
            "</task_progress>",
            "Still in progress. Continue other work or retry with the same task_id later.",
          ].join("\n"),
        );
      }
      const tag = existing.state === "completed" ? "task_result" : "task_error";
      const body = existing.resultText ?? existing.error ?? "";
      return taskEnvelope(
        resumeId,
        existing.state,
        `<summary>${args.description}</summary><${tag}>${body}</${tag}>`,
      );
    }

    // A new task needs both fields (enforced here, not in the schema, so the
    // control modes — task_id / cancel / list — don't have to carry them).
    if (!args.description?.trim() || !args.prompt?.trim()) {
      return taskEnvelope(
        "invalid",
        "error",
        `<task_error>A new task requires both "description" and "prompt". To act on an existing task, pass task_id (resume), task_id + cancel:true (stop it), or list:true (see running tasks).</task_error>`,
      );
    }

    const taskId = randomUUID();
    const subagentType = args.subagent_type?.trim() || "";
    // Set for background tasks so the main agent can hard-cancel them mid-flight.
    let taskAbort: AbortController | undefined;

    // R3: tee live activity into the task's progress buffer (so `task({task_id})`
    // / `task({list})` can show a running sub-agent's progress) and forward to the
    // UI emitter. Capture useful progress only — narration text + FINISHED tool
    // calls; skip raw reasoning (high-volume) and running markers.
    const bufferingEmit = (payload: SubagentActivityEmit) => {
      if (
        payload.type === "subagent_thought" &&
        payload.channel === "text" &&
        payload.content
      ) {
        appendSubagentOutput(taskId, payload.content);
      } else if (payload.type === "tool_use" && payload.status === "done") {
        const d = payload.detail ? `: ${payload.detail.slice(0, 200)}` : "";
        appendSubagentOutput(taskId, `\n[done ${payload.toolName}${d}]\n`);
      }
      args.emitSubagentActivity?.(payload);
    };

    const run = async () => {
      // Writer mode: isolate the sub-agent's writes in a throwaway git worktree.
      let worktree: SubagentWorktree | null = null;
      let modeNote = "";
      if (args.write && args.workspace?.trim()) {
        worktree = await createSubagentWorktree(args.workspace, taskId);
        if (!worktree) {
          modeNote =
            "\n\n(Note: workspace is not a git repository — ran read-only; could not isolate writes.)";
        }
      }

      try {
        const outcome = await runSubagent({
          prompt: args.prompt,
          subagentType: subagentType || undefined,
          workspace: args.workspace,
          mode: worktree ? "implement" : "scout",
          worktreePath: worktree?.worktreePath,
          workspaceId: args.workspaceId,
          chatId: args.chatId,
          turnId: args.turnId,
          delegationChatMode: args.delegationChatMode,
          delegationId: args.parentDelegationId ?? taskId,
          emit: bufferingEmit,
          abortSignal: taskAbort?.signal,
        });

        // Capture the proposed diff before teardown so the main agent can review
        // and apply it through its own (approval-gated) write tools.
        let diffBlock = "";
        if (worktree) {
          try {
            const diff = await captureWorktreeDiff(worktree);
            if (diff.changedFiles.length > 0) {
              const body =
                diff.unifiedDiff.length > MAX_DIFF_CHARS
                  ? diff.unifiedDiff.slice(0, MAX_DIFF_CHARS) + "\n…[diff truncated]"
                  : diff.unifiedDiff;
              diffBlock =
                `\n\n## Proposed changes (isolated worktree — review, then apply with your write tools)\n` +
                `Changed files: ${diff.changedFiles.join(", ")}\n\n` +
                "```diff\n" + body + "\n```";
            } else {
              diffBlock = "\n\n(The writer sub-agent made no file changes.)";
            }
          } catch {
            diffBlock = "\n\n(Could not capture the worktree diff.)";
          }
        }

        const rec = taskStore.get(taskId);
        if (!rec) return;
        if (outcome.success) {
          rec.state = "completed";
          rec.resultText = (outcome.summary ?? "") + modeNote + diffBlock;
        } else {
          rec.state = "error";
          rec.error = (outcome.error ?? "Sub-agent run failed") + modeNote;
        }
        rec.finishedAt = Date.now();
      } finally {
        if (worktree && args.workspace) {
          await removeSubagentWorktree(args.workspace, worktree);
        }
      }
    };

    taskStore.set(taskId, {
      id: taskId,
      state: "running",
      subagentType,
      prompt: args.prompt,
      startedAt: Date.now(),
      chatId: args.chatId,
      description: args.description,
    });

    if (args.background) {
      const chatId = args.chatId;
      if (chatId != null) recordSubagentStart(chatId, taskId);

      // Hard-cancel handle: the main agent can abort this sub-agent's model
      // stream via `task({ task_id, cancel: true })` (cancelSubagentTask).
      taskAbort = new AbortController();
      const rec0 = taskStore.get(taskId);
      if (rec0) rec0.abort = taskAbort;

      // Record the result into the per-chat store exactly once (on completion,
      // failure, or timeout) so prepareStep can fold it into the turn as it
      // arrives — no polling needed.
      let settled = false;
      const finalize = (state: "completed" | "error", body: string) => {
        if (settled) return;
        // The main agent cancelled this task — it already got the confirmation
        // in-band; do NOT inject a duplicate result via the auto-wake path.
        if (taskStore.get(taskId)?.cancelled) {
          settled = true;
          return;
        }
        settled = true;
        if (chatId == null) return;
        const rec = taskStore.get(taskId);
        const durationMs = Date.now() - (rec?.startedAt ?? Date.now());
        recordSubagentResult(chatId, taskId, {
          description: args.description,
          state,
          body,
          durationMs,
        });
      };

      const timeoutMs = backgroundTimeoutMs();
      const timeout = setTimeout(() => {
        const rec = taskStore.get(taskId);
        if (rec && rec.state === "running") {
          rec.state = "error";
          rec.error = `Sub-agent timed out after ${Math.round(timeoutMs / 1000)}s`;
          rec.finishedAt = Date.now();
        }
        finalize(
          "error",
          `Sub-agent timed out after ${Math.round(timeoutMs / 1000)}s and was abandoned. If still needed, spawn a narrower task.`,
        );
      }, timeoutMs);

      void run()
        .catch((err) => {
          const rec = taskStore.get(taskId);
          if (!rec) return;
          // Keep the "Cancelled by the main agent." message (the abort surfaces
          // here as an AbortError) — don't overwrite it with the raw error.
          if (rec.cancelled) return;
          rec.state = "error";
          rec.error = err instanceof Error ? err.message : String(err);
          rec.finishedAt = Date.now();
        })
        .finally(() => {
          clearTimeout(timeout);
          const rec = taskStore.get(taskId);
          const state = rec?.state === "completed" ? "completed" : "error";
          finalize(state, rec?.resultText ?? rec?.error ?? "");
        });

      return taskEnvelope(
        taskId,
        "running",
        [
          "<summary>Background task started</summary>",
          "<task_result>",
          "Background sub-agent started. You'll receive its result automatically when it finishes — keep doing other work; no need to poll with task_id.",
          "</task_result>",
        ].join("\n"),
      );
    }

    await run();
    const done = taskStore.get(taskId)!;
    const tag = done.state === "completed" ? "task_result" : "task_error";
    const body = done.resultText ?? done.error ?? "";
    return taskEnvelope(
      taskId,
      done.state === "completed" ? "completed" : "error",
      `<summary>${args.description}</summary><${tag}>${body}</${tag}>`,
    );
  },
});
