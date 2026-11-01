/**
 * schedule_wakeup (R1) — let the model schedule a harness self-wake.
 *
 * For re-checking external state the harness can't notify you about on its own
 * (a deploy, a remote queue, a long job with no completion signal). OPTIONAL and
 * fallback-safe: finished background jobs/sub-agents already wake you
 * automatically, so this is only for when there is no event to wait on. The
 * delay is at least 60s with no arbitrary upper cap (owner rule: loop termination
 * = no caps); when it fires you get a re-check nudge.
 */

import { ToolRegistry } from "./registry";
import { scheduleWakeup } from "@/lib/agent/scheduled-wakeups";

type WithChat<T> = T & { _chatSessionId?: number };

ToolRegistry.register({
  name: "schedule_wakeup",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  description:
    "Schedule the system to re-engage you after a delay to re-check something it can't notify you about on its own — e.g. an external deploy, a remote queue, or a long task with no completion signal. " +
    "delay_seconds is at least 60, with no arbitrary upper cap. For anything that REPEATS or outlives one turn (watch a page daily until X), create an automation instead of a wake-up chain — a wake-up is in-memory and lost on restart. " +
    "OPTIONAL: finished background jobs and sub-agents already wake you automatically, so use this ONLY when there is no event to wait on. If the event IS observable in a job's output, prefer run_command wake_on (or background_jobs watch) over a timed re-check; if it's an external state, background a command that blocks until it (e.g. `gh run watch`). When it fires you'll get a re-check nudge with your note.",
  parameters: {
    type: "object",
    properties: {
      delay_seconds: {
        type: "number",
        description:
          "Seconds to wait before re-engaging (at least 60; no arbitrary upper cap).",
      },
      note: {
        type: "string",
        description: "Optional reminder of what to re-check when you wake.",
      },
    },
    required: ["delay_seconds"],
  },
  handler: async (
    args: WithChat<{ delay_seconds?: number; note?: string }>,
  ) => {
    const chatId = args._chatSessionId;
    if (chatId == null) {
      return { success: false, error: "No chat session for schedule_wakeup." };
    }
    const seconds = Number(args.delay_seconds);
    const res = scheduleWakeup(
      chatId,
      (Number.isFinite(seconds) ? seconds : 0) * 1000,
      args.note ?? "",
    );
    if ("error" in res) {
      return { success: false, error: res.error };
    }
    return {
      success: true,
      id: res.id,
      fires_in_seconds: Math.round(res.firesInMs / 1000),
      note: "Scheduled. Keep doing other work — you'll be re-engaged with your note when it fires.",
    };
  },
});
