/**
 * `task` — the ONE sub-agent tool (v13).
 *
 * Spawns a scoped sub-agent (runSubagent): read-only by default, or a WRITER
 * (`write: true`, or a writer `subagent_type`) whose edits are captured as
 * PROPOSALS (never written) and handed back per file for the main agent to
 * review and accept. Issue MULTIPLE task calls in one response for independent scopes — they
 * run concurrently (up to 5 per turn). `background: true` returns immediately with
 * a task id to resume via `task_id`. `subagent_type` may name a built-in
 * (explorer / architect / implementer) or a user-defined `.atlarix/agents/` agent.
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
  notifySubagentStalled,
  recordSubagentStart,
  recordSubagentResult,
} from "../agents/subagent-results";
import {
  closeProposalSet,
  createProposalSet,
  deleteProposalSet,
  dropProposalSetsForChat,
} from "../agents/subagent-proposals";
import { buildProposalFileViews } from "../agents/subagent-proposal-review";
import { subagentWillWrite } from "../agents/user-agents";

/**
 * Wall-clock cap for a background sub-agent so a hung one can't stall the turn.
 * 10 min: a read-only scout on a large repo (or a slower model / slow network)
 * can legitimately run several minutes of grep/read/reason rounds. It's
 * backgrounded (never blocks the main turn) and now cancellable via
 * `task({ task_id, cancel: true })`, so a generous bound is cheap. Override with
 * ATLARIX_SUBAGENT_TIMEOUT_MS.
 */
const DEFAULT_BACKGROUND_TIMEOUT_MS = 10 * 60_000;

/**
 * A FOREGROUND sub-agent still running at this point is moved to the
 * background, exactly as `run_command` does at its own PROMOTE_AFTER_MS
 * (interceptor.ts). Longer than the command's 15s because a sub-agent's first
 * model round alone can take that long, and a quick recon returning inline is
 * worth more than shaving a few seconds off a slow one.
 */
const SUBAGENT_PROMOTE_AFTER_MS = 30_000;

/** No activity for this long → one "stalled" nudge to the main agent. */
const SUBAGENT_STALL_AFTER_MS = 120_000;
const SUBAGENT_STALL_CHECK_MS = 15_000;
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
  /** Writer runs: the proposal set awaiting the main agent's review. */
  proposalSetId?: string;
  /** Cursor into `output` for incremental (mode:"new") reads. */
  readOffset?: number;
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

/** Running background sub-agents for a chat (for `subagents({operation:"list"})`). */
export function listRunningSubagentTasks(
  chatId: number | undefined,
): Array<{
  taskId: string;
  description: string;
  elapsedMs: number;
  lastOutput: string;
  stalled: boolean;
}> {
  const now = Date.now();
  const out: Array<{
    taskId: string;
    description: string;
    elapsedMs: number;
    lastOutput: string;
    stalled: boolean;
  }> = [];
  for (const rec of taskStore.values()) {
    if (rec.state !== "running") continue;
    if (chatId != null && rec.chatId !== chatId) continue;
    out.push({
      taskId: rec.id,
      description: rec.description ?? rec.subagentType ?? "(task)",
      elapsedMs: now - rec.startedAt,
      lastOutput: subagentOutputTail(rec, 160).replace(/\s+/g, " ").trim(),
      stalled:
        now - (rec.lastActivityAt ?? rec.startedAt) >= SUBAGENT_STALL_AFTER_MS,
    });
  }
  return out;
}

/**
 * Address a sub-agent by id, by the NAME the model gave it, or by a distinctive
 * part of that name — the same resolution `background_jobs` does for `job`
 * (exact id → substring → an ambiguity error that lists the candidates). A
 * generated uuid is a string the model has to carry perfectly across turns; a
 * name it chose itself is far harder to get wrong.
 *
 * Unlike the jobs resolver this also matches FINISHED tasks, so reading the
 * output of one that just completed isn't a dead end.
 */
export function resolveSubagentTaskId(
  chatId: number | undefined,
  wanted: string,
): { id: string } | { error: string } {
  const mine = [...taskStore.values()].filter(
    (r) => chatId == null || r.chatId === chatId,
  );
  const exact = mine.find((r) => r.id === wanted);
  if (exact) return { id: exact.id };

  const needle = wanted.toLowerCase();
  const named = mine.filter(
    (r) => (r.description ?? "").toLowerCase() === needle,
  );
  if (named.length === 1) return { id: named[0].id };

  const partial = mine.filter((r) =>
    (r.description ?? "").toLowerCase().includes(needle),
  );
  if (partial.length === 1) return { id: partial[0].id };
  if (partial.length > 1) {
    return {
      error:
        `"${wanted}" matches ${partial.length} sub-agents: ` +
        `${JSON.stringify(partial.map((r) => ({ task_id: r.id, name: r.description, state: r.state })))}. ` +
        "Use the task_id of the one you mean.",
    };
  }
  return {
    error:
      `No sub-agent matches "${wanted}". In this session: ` +
      `${JSON.stringify(mine.map((r) => ({ task_id: r.id, name: r.description, state: r.state })))}.`,
  };
}

/**
 * Read a sub-agent's buffered narration. "new" returns what appeared since the
 * last read (and moves the cursor); "tail" returns the most recent output and
 * leaves the cursor alone, so asking "what is it doing NOW" never costs the
 * next incremental read.
 */
export function readSubagentOutput(
  taskId: string,
  mode: "new" | "tail",
  maxChars: number,
): {
  found: boolean;
  state?: TaskRecord["state"];
  text?: string;
  elapsedMs?: number;
  stalled?: boolean;
} {
  const rec = taskStore.get(taskId);
  if (!rec) return { found: false };
  const buf = rec.output ?? "";
  const now = Date.now();
  const common = {
    found: true as const,
    state: rec.state,
    elapsedMs: (rec.finishedAt ?? now) - rec.startedAt,
    stalled:
      rec.state === "running" &&
      now - (rec.lastActivityAt ?? rec.startedAt) >= SUBAGENT_STALL_AFTER_MS,
  };
  if (mode === "tail") {
    return {
      ...common,
      text: buf.length > maxChars ? "…" + buf.slice(-maxChars) : buf,
    };
  }
  // The buffer is a capped TAIL, so a stored cursor can outrun it after
  // truncation — clamp rather than return garbage.
  const from = Math.min(rec.readOffset ?? 0, buf.length);
  rec.readOffset = buf.length;
  const slice = buf.slice(from);
  return {
    ...common,
    text: slice.length > maxChars ? "…" + slice.slice(-maxChars) : slice,
  };
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
  // The turn is over, so no one is going to review a pending proposal set —
  // holding those file bodies in the main process would just be a leak.
  dropProposalSetsForChat(chatId);
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
    "WHEN to use it: delegate work that is INDEPENDENT of your current thread or that you'd otherwise run in PARALLEL (several unrelated questions, a broad codebase/web sweep). For a small or single-step scope, just do it inline — spawning a sub-agent adds latency and its own context. " +
    "For independent scopes, issue MULTIPLE task calls in ONE response — they run concurrently (up to 5 per turn). " +
    "By default a sub-agent is READ-ONLY. Set write=true to let it implement a change: it writes NOTHING to disk — every edit comes back as a per-file PROPOSAL you review and accept with the `proposals` tool, which writes its exact bytes through the normal approval gate. Review each diff before accepting; to fix a mostly-right change, accept it then edit_file on top. Works in any workspace, git or not. " +
    "Optional subagent_type names a built-in agent (explorer = read-only recon, architect = planning, implementer = writer) or a user-defined .atlarix/agents/ agent; a writer agent implies write mode without write=true. " +
    "Give every task a short, distinctive `description` — that is the NAME you address it by later, and a name you chose is far easier to get right than a generated id. " +
    "Set background=true to return immediately with a task id; pass task_id later to collect the result. A foreground task still running after 30s is moved to the background automatically, so it never blocks your turn. " +
    "PREFER background=true for ANY long-running delegation — read-only recon/research sweeps AND writer/implementer tasks alike: you can continue other work or end your turn, and each result is delivered to you automatically the moment it finishes (you are auto-woken if your turn ended). Do not idle or poll while waiting. " +
    "To see, read, or stop running sub-agents, use the `subagents` tool.",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      description: stringParam(
        "Short (3-5 word) description — also the NAME you address this sub-agent by in the `subagents` tool, so make it distinctive.",
      ),
      prompt: stringParam("Full task prompt for the sub-agent"),
      subagent_type: stringParam(
        "Optional built-in (explorer=read-only recon, architect=planning, implementer=WRITER) or a .atlarix/agents/ name; omit for the generic read-only scout. Note: a writer type (e.g. implementer) turns on write mode by itself — no write=true needed.",
      ),
      task_id: stringParam(
        "Resume a prior background task (same sub-agent session)",
      ),
      background: booleanParam(
        "When true, run async and return immediately with task id",
      ),
      write: booleanParam(
        "When true, the sub-agent may use edit_file. Its changes are NOT written — they return as per-file proposals for you to review and accept with the `proposals` tool. No git repository required.",
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

    // list/cancel moved to the `subagents` tool in v14.21.0 so that spawning and
    // managing aren't the same overloaded surface (task : subagents ::
    // run_command : background_jobs). Redirect rather than fail blind — a
    // dead-end here costs the model a whole step.
    if (args.list || args.cancel) {
      return taskEnvelope(
        resumeId || "n/a",
        "error",
        `<task_error>Managing sub-agents moved to the \`subagents\` tool: subagents({operation:"list"}), subagents({operation:"output", agent:"<name>"}), or subagents({operation:"cancel", agent:"<name>"}). You can address one by the name you gave it, not just its id.</task_error>`,
      );
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
    // v14.8.7 §C: every sub-agent (foreground scouts included, not just
    // background) gets an abort controller so a user cancel can hard-stop its
    // model stream — foreground scouts were previously uncancelable.
    const taskAbort = new AbortController();

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

    // A writer is either an explicit write=true or a named writer agent (its
    // toolset includes edit_file) — single source of truth (subagentWillWrite).
    const willWrite =
      !!args.workspace?.trim() &&
      subagentWillWrite({
        write: args.write,
        subagentType: subagentType || undefined,
        workspacePath: args.workspace!.trim(),
      });

    const run = async () => {
      // Writer mode: every edit_file the sub-agent makes is recorded here
      // instead of being written. The set is also its read overlay, so it sees
      // its own edits; nothing reaches the real workspace until the main agent
      // accepts a file through the ordinary approval gate.
      const proposalSetId = willWrite
        ? createProposalSet({
            chatId: args.chatId ?? -1,
            taskId,
            agentName: args.description?.trim() || subagentType || taskId,
            workspace: args.workspace!.trim(),
          })
        : "";

      let keepProposals = false;
      try {
        const outcome = await runSubagent({
          prompt: args.prompt,
          subagentType: subagentType || undefined,
          workspace: args.workspace,
          mode: proposalSetId ? "implement" : "scout",
          proposalSetId: proposalSetId || undefined,
          workspaceId: args.workspaceId,
          chatId: args.chatId,
          turnId: args.turnId,
          delegationChatMode: args.delegationChatMode,
          delegationId: args.parentDelegationId ?? taskId,
          emit: bufferingEmit,
          abortSignal: taskAbort.signal,
        });

        // Hand the main agent real per-file diffs rather than one truncated
        // markdown blob. Each file is capped separately, so a large first file
        // can no longer starve the rest of the set.
        let proposalBlock = "";
        if (proposalSetId) {
          const set = closeProposalSet(proposalSetId);
          const views = set ? buildProposalFileViews(set) : [];
          if (views.length > 0) {
            keepProposals = true;
            const header =
              `\n\n<subagent_proposals id="${proposalSetId}" files="${views.length}">\n` +
              `${views.length} proposed file change(s). NOTHING has been written. Review each, then ` +
              `proposals({operation:"accept", proposal:"${proposalSetId}", file:"<path>"}) to land it ` +
              `byte-for-byte, or proposals({operation:"reject", ...}) with a reason.\n`;
            const body = views
              .map(
                (v) =>
                  `\n## ${v.relPath} (${v.type}, +${v.added} \u2212${v.removed})\n` +
                  "```diff\n" +
                  v.diff +
                  "\n```",
              )
              .join("\n");
            proposalBlock = header + body + "\n</subagent_proposals>";
          } else {
            // A writer that actually edited leaves proposals here. None is a
            // factual signal: treat any "I edited X" narration as unconfirmed.
            proposalBlock =
              "\n\n(The writer sub-agent finished without proposing any file changes. Disregard any claim of edits above.)";
          }
        }

        const rec = taskStore.get(taskId);
        if (!rec) return;
        if (outcome.success) {
          rec.state = "completed";
          rec.resultText = (outcome.summary ?? "") + proposalBlock;
          rec.proposalSetId = keepProposals ? proposalSetId : undefined;
        } else {
          rec.state = "error";
          rec.error = outcome.error ?? "Sub-agent run failed";
        }
        rec.finishedAt = Date.now();
      } finally {
        // A set with nothing to review (or a failed run) is dropped now; one
        // awaiting review is owned by the `proposals` tool from here.
        if (proposalSetId && !keepProposals) deleteProposalSet(proposalSetId);
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
      abort: taskAbort,
    });

    // Start the run either way. A foreground call races it against the
    // promotion timer below; a background call just attaches bookkeeping.
    const runPromise = run();
    const chatId = args.chatId;

    /**
     * Everything a background sub-agent needs: the running registration that
     * drives the auto-wake, the result hand-back, the stall nudge, and the hard
     * timeout. Called for an explicit background:true AND for a foreground task
     * promoted at SUBAGENT_PROMOTE_AFTER_MS — they are the same thing after the
     * decision point, so they must not be two code paths that drift.
     */
    const attachBackgroundBookkeeping = () => {
      if (chatId != null) recordSubagentStart(chatId, taskId);

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

      // Stall nudge. `lastActivityAt` was recorded from the very first version
      // of this file and never read — so a sub-agent that wedged just held the
      // turn open in silence. The renderer's wake closure already treats
      // "stalled" as a wake reason, so surfacing it here is the whole fix.
      // Fires ONCE: a nudge, not a nag. The timeout below is the hard backstop.
      let stallNotified = false;
      const stallWatch = setInterval(() => {
        const rec = taskStore.get(taskId);
        if (!rec || rec.state !== "running") return;
        if (stallNotified || chatId == null) return;
        const quietFor = Date.now() - (rec.lastActivityAt ?? rec.startedAt);
        if (quietFor >= SUBAGENT_STALL_AFTER_MS) {
          stallNotified = true;
          notifySubagentStalled(chatId, taskId);
        }
      }, SUBAGENT_STALL_CHECK_MS);

      const timeoutMs = backgroundTimeoutMs();
      const timeout = setTimeout(() => {
        const rec = taskStore.get(taskId);
        if (rec && rec.state === "running") {
          rec.state = "error";
          rec.error = `Sub-agent timed out after ${Math.round(timeoutMs / 1000)}s`;
          rec.finishedAt = Date.now();
        }
        // Abort the model stream so run()'s finally releases the proposal set
        // promptly (and token spend stops) instead of lingering until the
        // stream ends on its own.
        taskAbort?.abort();
        finalize(
          "error",
          `Sub-agent timed out after ${Math.round(timeoutMs / 1000)}s and was abandoned. If still needed, spawn a narrower task.`,
        );
      }, timeoutMs);

      void runPromise
        .catch((err) => {
          const rec = taskStore.get(taskId);
          if (!rec) return;
          // Keep an already-terminal message (main-agent cancel or timeout) — the
          // abort surfaces here as an AbortError; don't clobber it with the raw error.
          if (rec.cancelled || rec.finishedAt) return;
          rec.state = "error";
          rec.error = err instanceof Error ? err.message : String(err);
          rec.finishedAt = Date.now();
        })
        .finally(() => {
          clearTimeout(timeout);
          clearInterval(stallWatch);
          const rec = taskStore.get(taskId);
          const state = rec?.state === "completed" ? "completed" : "error";
          finalize(state, rec?.resultText ?? rec?.error ?? "");
        });
    };

    if (args.background) {
      attachBackgroundBookkeeping();
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

    // Auto-promotion, mirroring run_command's PROMOTE_AFTER_MS. A foreground
    // task() previously had NO timeout of any kind — it blocked the turn for as
    // long as the sub-agent took, which is what "the sub-agent looks stuck"
    // actually was. Now it hands back a task id and the turn keeps moving; the
    // result still arrives automatically.
    let promoteTimer: NodeJS.Timeout | undefined;
    const promoted = await Promise.race([
      // Settled either way means it finished in time — the catch is handled
      // below off taskStore, exactly as before.
      runPromise.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        promoteTimer = setTimeout(() => resolve(true), SUBAGENT_PROMOTE_AFTER_MS);
      }),
    ]);
    if (promoteTimer) clearTimeout(promoteTimer);

    if (promoted) {
      attachBackgroundBookkeeping();
      return taskEnvelope(
        taskId,
        "running",
        [
          `<summary>${args.description}</summary>`,
          "<task_result>",
          `Still running after ${Math.round(SUBAGENT_PROMOTE_AFTER_MS / 1000)}s — moved to the background (task_id: ${taskId}).`,
          "You'll receive its result automatically when it finishes — continue other work, don't poll, and you may end your turn while it runs.",
          `Check or stop it with subagents({operation:"output"|"cancel", agent:"${args.description}"}).`,
          "</task_result>",
        ].join("\n"),
      );
    }

    // Already started above and awaited by the race — awaiting the same promise
    // is what surfaces its rejection here; calling run() again would execute the
    // whole sub-agent a SECOND time.
    await runPromise;
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
