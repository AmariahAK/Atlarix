/**
 * `task_complete` — the agent's explicit "I'm done" signal via native function
 * calling. Replaces the legacy `<task_complete>` XML sentinel: models reliably
 * CALL described tools but unreliably emit a magic string. Calling this tool
 * records a completion request for the turn; the agentic loop
 * (`run-agent-turn.ts`) sees it, runs the completion gates (stop-hook +
 * mutation-verify), then ends the turn — reusing the existing completion path,
 * so every downstream effect (plan finalize, snapshot, persistence,
 * `chat:response:end`, headless exit) fires unchanged.
 *
 * A no-tool-call round is a safety-net fallback (run-agent-turn.ts) so a
 * forgotten call can never hang the loop. The XML tag is still parsed for
 * back-compat.
 *
 * Offered in the agentic modes (build/debug) only — ask/plan/review are
 * single-round and end naturally. `requiresWorkspace: false` so completion is
 * always reachable; `isReadOnly` (no mutation). Mode allowlists keep it out of
 * ask/plan/review; build/debug ("*") include it.
 */

import { ToolRegistry, createParameters, stringParam } from "./registry";

ToolRegistry.register({
  name: "task_complete",
  description:
    "Signal that the task is fully done and verified — the project's checks/tests pass and nothing blocks progress. Pass a brief `summary` of what you accomplished. Calling this ends your turn; do not call it while work, edits, or commands are still pending or failing.",
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  allowInAskMode: false,
  parameters: createParameters(
    {
      summary: stringParam(
        "A brief summary of what was accomplished (one or two sentences).",
      ),
    },
    [],
  ),
  // The completion request itself is recorded in runToolExecute (it owns the
  // turnId); this handler just acknowledges so the model sees the call landed.
  handler: async (args: { summary?: string }) => {
    const summary =
      typeof args?.summary === "string" ? args.summary.trim() : "";
    return {
      success: true,
      acknowledged: true,
      message: "Task marked complete; ending the turn.",
      ...(summary ? { summary } : {}),
    };
  },
});
