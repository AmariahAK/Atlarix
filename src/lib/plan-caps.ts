/**
 * The per-workspace plan caps, in one place.
 *
 * WHY THEY MOVED HERE
 * -------------------
 * These numbers now appear in three kinds of place: the handlers that ENFORCE
 * them, the tool results that REPORT them, and the tool descriptions the model
 * READS. A description saying "10" while the constant says something else is the
 * hardcoding trap this codebase has fixed repeatedly — and a prompt is the one
 * place nothing would ever catch the drift, because no test and no type checks
 * an English sentence against a number.
 *
 * So the caps live here and every consumer interpolates. Change the number once
 * and the enforcement, the reported limit and the sentence the model reads all
 * move together.
 */

/** MCP servers per workspace. */
export const MCP_FREE_MAX = 1;
export const MCP_PRO_MAX = 10;

/** Automations per workspace. */
export const AUTOMATIONS_FREE_MAX = 2;
export const AUTOMATIONS_PRO_MAX = 10;

export type PlanTier = "free" | "pro";

export type PlanCapStatus = {
  tier: PlanTier;
  /** How many exist in this workspace right now. */
  used: number;
  /** The cap that applies to THIS user, not the maximum that exists. */
  max: number;
  canAddMore: boolean;
  /** The cap on the other tier, so the model can say what upgrading buys. */
  proMax: number;
};

/**
 * Shape a cap for a tool result.
 *
 * Reported rather than merely enforced: the agent could otherwise only discover
 * a limit by hitting it, at which point a refusal reads as "something is wrong
 * with this workspace" rather than "you are on Free". It has no other way to
 * know the tier — nothing in the system prompt, the mode bundles or AGENTS.md
 * mentions a plan.
 */
export function describePlanCap(
  kind: "mcp" | "automations",
  isPro: boolean,
  used: number,
): PlanCapStatus {
  const proMax = kind === "mcp" ? MCP_PRO_MAX : AUTOMATIONS_PRO_MAX;
  const freeMax = kind === "mcp" ? MCP_FREE_MAX : AUTOMATIONS_FREE_MAX;
  const max = isPro ? proMax : freeMax;
  return {
    tier: isPro ? "pro" : "free",
    used,
    max,
    canAddMore: used < max,
    proMax,
  };
}

/**
 * The sentence the model reads in a tool description.
 *
 * Says the caps AND what to do when one is hit, because the useful failure is
 * not "you were refused" but "you were refused for a reason with two known
 * remedies". Without the second half the model tends to retry or to report a
 * plan limit as a defect.
 */
export function planCapClause(kind: "mcp" | "automations"): string {
  const noun = kind === "mcp" ? "MCP servers" : "automations";
  const freeMax = kind === "mcp" ? MCP_FREE_MAX : AUTOMATIONS_FREE_MAX;
  const proMax = kind === "mcp" ? MCP_PRO_MAX : AUTOMATIONS_PRO_MAX;
  return (
    `PLAN LIMIT: ${freeMax} ${noun} per workspace on Free, ${proMax} on Pro — ` +
    `\`list\` reports the tier, the count and whether there is room. ` +
    `If a create is refused by this cap it is a plan limit, NOT a broken workspace: ` +
    `say which limit was hit and offer the two real options — remove an existing one, or upgrade — instead of retrying.`
  );
}
