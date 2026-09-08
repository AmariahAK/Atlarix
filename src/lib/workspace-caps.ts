/**
 * The per-workspace caps, in one place.
 *
 * WHY THEY LIVE HERE
 * ------------------
 * These numbers appear in three kinds of place: the handlers that ENFORCE them, the
 * tool results that REPORT them, and the tool descriptions the model READS. A
 * description saying "10" while the constant says something else is the hardcoding trap
 * this codebase has fixed repeatedly — and a prompt is the one place nothing would ever
 * catch the drift, because no test and no type checks an English sentence against a
 * number.
 *
 * So the caps live here and every consumer interpolates.
 *
 * THESE ARE RESOURCE LIMITS, NOT PLAN LIMITS — and that is the whole change of
 * 2026-09-08. This file used to be `plan-caps.ts` and carried a Free number and a Pro
 * number for each cap, plus the tier plumbing to choose between them. The desktop app is
 * now free: every feature is available on every plan, and what you pay for is Atlarix
 * Core inference. The numbers that remain exist because a workspace with fifty MCP
 * servers is a workspace nobody can reason about, not because somebody has not paid.
 *
 * That is why there is no `capRemedy` any more. Its whole job was saying "upgrade to
 * Pro" to one tier and "this is the ceiling" to the other; with one tier there is only
 * the ceiling, and the remedy is always the same sentence.
 */

/** MCP servers per workspace. */
export const MCP_WORKSPACE_MAX = 10;

/** Automations per workspace. */
export const AUTOMATIONS_WORKSPACE_MAX = 10;

export type WorkspaceCapStatus = {
  /** How many exist in this workspace right now. */
  used: number;
  max: number;
  canAddMore: boolean;
};

/**
 * Shape a cap for a tool result.
 *
 * Reported rather than merely enforced: the agent could otherwise only discover a limit
 * by hitting it, at which point a refusal reads as "something is wrong with this
 * workspace" rather than "this workspace is full".
 */
export function describeWorkspaceCap(
  kind: "mcp" | "automations",
  used: number,
): WorkspaceCapStatus {
  const max = kind === "mcp" ? MCP_WORKSPACE_MAX : AUTOMATIONS_WORKSPACE_MAX;
  return { used, max, canAddMore: used < max };
}

/**
 * The sentence the model reads in a tool description.
 *
 * Says the cap AND what to do when it is hit, because the useful failure is not "you
 * were refused" but "you were refused for a reason with a known remedy". Without the
 * second half the model tends to retry, or to report the cap as a defect.
 *
 * It must NOT mention plans or upgrading. There is nothing to upgrade to, and a model
 * that suggests a purchase which does not exist is worse than one that says nothing.
 */
export function workspaceCapClause(kind: "mcp" | "automations"): string {
  const noun = kind === "mcp" ? "MCP servers" : "automations";
  const max = kind === "mcp" ? MCP_WORKSPACE_MAX : AUTOMATIONS_WORKSPACE_MAX;
  return (
    `WORKSPACE LIMIT: ${max} ${noun} per workspace — ` +
    `\`list\` reports the count and whether there is room. ` +
    `If a create is refused by this cap the workspace is full, NOT broken: ` +
    `say which limit was hit instead of retrying, and remove one to add another. ` +
    `This is not a plan limit and there is no tier that raises it.`
  );
}
