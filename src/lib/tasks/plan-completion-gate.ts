/**
 * Continue-until-done gate (v14.8.9).
 *
 * Open-weight models stop in phases — they finish a chunk, summarize (a
 * prose-only round), and yield even though the session plan isn't done. This
 * gate feeds the existing prose-yield gate chain (run-agent-turn): when the
 * session's active plan still has incomplete steps, it returns a nudge to
 * continue instead of ending the turn. It is BOUNDED by PLAN_YIELD_MAX_NUDGES
 * (consecutive unproductive yields; resets on any real work) so a genuinely
 * stuck model still stops — the Claude-Code Stop-hook model, keyed off the plan
 * as an objective completion signal (Codex's "one in_progress step until done").
 *
 * Preserved by construction (checked at the call site): ask_user is a tool pause
 * (not a prose-yield), and background/sub-agent work parks BEFORE this gate runs.
 */

import { getLatestPlanArtifact } from "@/lib/plans/plan-artifacts";
import { parsePlanChecklist } from "./plan-checklist";

/**
 * Nudge string when the session's latest plan has steps that aren't `done`,
 * else null (no plan, empty plan, or all steps done → let the turn end).
 */
export async function getPlanCompletionFeedback(
  sessionId: string | undefined | null,
): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const row = await getLatestPlanArtifact(sessionId);
    if (!row?.content?.trim()) return null;
    const steps = parsePlanChecklist(row.content);
    if (steps.length === 0) return null;
    const remaining = steps.filter((s) => s.state !== "done");
    if (remaining.length === 0) return null;
    const list = remaining
      .slice(0, 8)
      .map((s) => `${s.index}. ${s.text}`)
      .join("; ");
    return (
      `The session plan is not finished — ${remaining.length} step(s) remain: ${list}. ` +
      "First: any listed step you have ALREADY completed, mark done via plan(update_step) now — NEVER redo or restart work that already succeeded. " +
      "Then continue with the next genuinely unfinished step, marking each done as you finish. " +
      "If every remaining step is actually done, mark them and end your turn with a summary. " +
      "Only stop early if you need the user (a decision or a manual test you can't run) or are genuinely blocked."
    );
  } catch {
    return null;
  }
}
