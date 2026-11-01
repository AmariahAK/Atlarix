/**
 * `subagents` — inspect and control running sub-agents (v14.21.0).
 *
 * `task` spawns, `subagents` manages — the same split as `run_command` and
 * `background_jobs`, deliberately, so there is one mental model for "work I
 * started that is still going" rather than two.
 *
 * This absorbed `task({list})` and `task({task_id, cancel})`, and adds the
 * thing neither had: reading a running sub-agent's live narration. Addressing
 * reuses the `background_jobs` dialect (id, name, or a distinctive substring),
 * because a generated uuid is exactly the kind of string a model gets one
 * character wrong.
 *
 * Available in EVERY mode, Plan included: a mode that can delegate must be able
 * to list, read and cancel what it delegated. (This note used to explain that
 * Plan lacked `background_jobs` "because Plan can't run commands" — Plan has
 * both now.)
 */

import {
  ToolRegistry,
  createParameters,
  numberParam,
  stringParam,
} from "./registry";
import {
  cancelSubagentTask,
  listRunningSubagentTasks,
  readSubagentOutput,
  resolveSubagentTaskId,
} from "./spawn-task";

const DEFAULT_OUTPUT_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 16_000;

ToolRegistry.register({
  name: "subagents",
  description:
    "Inspect and control the sub-agents you started with `task` — the sub-agent equivalent of background_jobs. " +
    // Name FIRST, id demoted to a fallback. Listing them as equal options meant a
    // model holding a task id from a prior result just used the id, which is
    // opaque in the transcript and easy to mismatch across turns; the name it
    // chose in task({description}) is self-describing and it already knows it.
    "Identify one with `agent`: PREFER the name you gave it in `task({description})` — a distinctive part of the name is enough. Fall back to its task id only when the name is ambiguous or you don't have it. " +
    'operation:"list" — sub-agents still running in this session (name, task id, elapsed, and whether one has gone quiet). ' +
    'operation:"output" — its live narration. Default mode:"new" returns what appeared since your last check; mode:"tail" returns the most recent output regardless, which is what you want to see what it is doing right now. Works on a finished sub-agent too. ' +
    'operation:"cancel" — hard-stop one that is stuck or no longer needed; this stops its token spend. ' +
    "Results are delivered to you automatically when a sub-agent finishes, so use this to CHECK ON or STOP one. A quiet sub-agent is usually still thinking.",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: true,
  parameters: createParameters(
    {
      operation: {
        type: "string",
        enum: ["list", "output", "cancel"],
        description:
          "What to do: list running sub-agents, read one's output, or cancel one.",
      },
      agent: stringParam(
        "Which sub-agent — prefer the name from task({description}) (part of it is enough); its task id also works. Required for output/cancel.",
      ),
      mode: {
        type: "string",
        enum: ["new", "tail"],
        description:
          'For operation:"output" — "new" (default) returns only what appeared since your last check; "tail" returns the most recent output regardless and does not consume your incremental position.',
      },
      max_chars: numberParam(
        `Max characters of narration to return (default ${DEFAULT_OUTPUT_CHARS}, max ${MAX_OUTPUT_CHARS}).`,
        DEFAULT_OUTPUT_CHARS,
        200,
        MAX_OUTPUT_CHARS,
      ),
    },
    ["operation"],
  ),
  handler: async (args: {
    operation?: string;
    agent?: string;
    mode?: string;
    max_chars?: number;
    _chatSessionId?: number;
  }) => {
    const chatId = args._chatSessionId;
    const operation = String(args.operation ?? "").toLowerCase();

    if (operation === "list") {
      const running = listRunningSubagentTasks(chatId);
      return {
        success: true,
        count: running.length,
        subagents: running.map((t) => ({
          name: t.description,
          task_id: t.taskId,
          elapsed_s: Math.round(t.elapsedMs / 1000),
          ...(t.stalled ? { stalled: true } : {}),
          ...(t.lastOutput ? { last_output: t.lastOutput } : {}),
        })),
        note:
          running.length === 0
            ? "No sub-agents are running. Finished ones already delivered their results."
            : undefined,
      };
    }

    if (operation !== "output" && operation !== "cancel") {
      return {
        success: false,
        error: `Unknown operation "${operation}". Use list | output | cancel.`,
      };
    }

    const wanted = String(args.agent ?? "").trim();
    if (!wanted) {
      return {
        success: false,
        error: `operation:"${operation}" requires \`agent\` — the name you gave it in task({description}) (part of it is enough), or its task id.`,
      };
    }
    const resolved = resolveSubagentTaskId(chatId, wanted);
    if ("error" in resolved) return { success: false, error: resolved.error };
    const taskId = resolved.id;

    if (operation === "cancel") {
      const res = cancelSubagentTask(chatId, taskId);
      return res.ok
        ? {
            success: true,
            task_id: taskId,
            cancelled: true,
            note: "Stopped — no result will be delivered for it.",
          }
        : { success: false, error: res.reason };
    }

    const mode =
      String(args.mode ?? "new").toLowerCase() === "tail" ? "tail" : "new";
    const maxChars = Math.min(
      MAX_OUTPUT_CHARS,
      Math.max(200, Number(args.max_chars) || DEFAULT_OUTPUT_CHARS),
    );
    const out = readSubagentOutput(taskId, mode, maxChars);
    if (!out.found) {
      return { success: false, error: `Unknown sub-agent: ${taskId}` };
    }

    const running = out.state === "running";
    return {
      success: true,
      task_id: taskId,
      mode,
      running,
      elapsed_s: Math.round((out.elapsedMs ?? 0) / 1000),
      ...(out.stalled ? { stalled: true } : {}),
      output:
        out.text && out.text.trim()
          ? out.text
          : mode === "new"
            ? "(nothing new since your last check)"
            : "(no output yet)",
      note: running
        ? out.stalled
          ? "This one has been quiet for a while. It may still be working — cancel it only if the scope no longer makes sense."
          : "Still running. Its result is delivered automatically — don't poll."
        : "Finished. Its result was already delivered to you.",
    };
  },
});
