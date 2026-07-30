/**
 * Continue-until-done gate (v14.8.9).
 *
 * Open-weight models stop in phases — they finish a chunk, summarize (a
 * prose-only round), and yield even though the session plan isn't done. This
 * gate feeds the existing prose-yield gate chain (run-agent-turn): when the
 * session's active plan still has steps the model can act on, it returns a nudge
 * to continue instead of ending the turn. It is BOUNDED by PLAN_YIELD_MAX_NUDGES
 * (consecutive unproductive yields; resets on any real work) so a genuinely
 * stuck model still stops — the Claude-Code Stop-hook model, keyed off the plan
 * as an objective completion signal (Codex's "one in_progress step until done").
 *
 * v14.23.0: it fires on `todo`/`in_progress` ONLY. A step the model has marked
 * `external` (the user's to do) or `blocked` (stuck, with a reason) is an ANSWER,
 * and re-asking for it was the harness overriding a correct decision.
 *
 * Preserved by construction (checked at the call site): ask_user is a tool pause
 * (not a prose-yield), and background/sub-agent work parks BEFORE this gate runs.
 */

import { getLatestPlanArtifact } from "@/lib/plans/plan-artifacts";
import { isActionableStepState, parsePlanChecklist } from "./plan-checklist";

/**
 * Nudge string when the session's plan still has steps the model can ACT on, else
 * null (no plan, empty plan, or every step dispositioned → let the turn end).
 *
 * The question is "have you accounted for every step?", NOT "is every step done?".
 * The old test was `state !== "done"`, which counted `blocked` as remaining — so a
 * step needing the user held the turn open and the nudge told the model to carry on
 * with it, up to 6 consecutive / 12 per-turn times. `external` and `blocked` are
 * both answers; only `todo`/`in_progress` are silence.
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
    const remaining = steps.filter((s) => isActionableStepState(s.state));
    if (remaining.length === 0) return null;
    const list = remaining
      .slice(0, 8)
      .map((s) => `${s.index}. ${s.text}`)
      .join("; ");
    return (
      `The session plan has ${remaining.length} step(s) you haven't accounted for: ${list}. ` +
      "Mark each one with plan(update_step): done if you already finished it (never redo work that succeeded), " +
      "external + reason if it's the user's to do (a dashboard action, a manual test, hardware you don't have), " +
      "or blocked + say why if you're stuck. Otherwise continue with the next one. " +
      "Once no step is left for you, end your turn with a summary of what you did and what the user still needs to do."
    );
  } catch {
    return null;
  }
}
