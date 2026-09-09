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

/**
 * THERE IS NO SKILLS CAP, and this note is here so nobody adds one back.
 *
 * `SKILLS_WORKSPACE_MAX = 10` was retired in v14.45 with the skills marketplace, because
 * its ONLY enforcement site was `skills:install` — the code that deletion removed. Repo
 * skills under `.atlarix/skills/` were never capped at all (`skill-index.ts`: "Nothing is
 * capped and nothing is clipped"), so keeping the constant would have left a number in
 * the codebase that described nothing.
 *
 * It is also not enforceable by nature: these are files the user put in their own repo,
 * and you cannot refuse a file that already exists. What bounds their cost is the skill
 * INDEX — one line each, and searchable rather than wholesale — not a count.
 *
 * MCP 10 and automations 10 are untouched and stay.
 */

/** The capped resources. Adding one here forces every consumer to handle it. */
export type WorkspaceCapKind = "mcp" | "automations";

const CAP_MAX: Record<WorkspaceCapKind, number> = {
  mcp: MCP_WORKSPACE_MAX,
  automations: AUTOMATIONS_WORKSPACE_MAX,
};

const CAP_NOUN: Record<WorkspaceCapKind, string> = {
  mcp: "MCP servers",
  automations: "automations",
};

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
  kind: WorkspaceCapKind,
  used: number,
): WorkspaceCapStatus {
  const max = CAP_MAX[kind];
  return { used, max, canAddMore: used < max };
}

/**
 * The refusal a user or the agent sees when a cap is hit.
 *
 * ONE builder, because a second copy is how the skills cap ended up with two wordings
 * and two numbers. A caller that catches this error should DISPLAY it rather than
 * rebuild it — rebuilding is what let the shown cap disagree with the enforced one.
 *
 * `WORKSPACE_CAP_MARKER` is the stable substring; everything around it may be reworded
 * freely. Same discipline as `CORE_EXHAUSTED_MARKER` in `billing_copy.ts`, and for the
 * same reason: something downstream matches on it.
 */
export const WORKSPACE_CAP_MARKER = "workspace limit reached";

export function workspaceCapRefusal(kind: WorkspaceCapKind): string {
  const max = CAP_MAX[kind];
  return (
    `Workspace limit reached — ${max} ${CAP_NOUN[kind]} per workspace. ` +
    `Remove one to add another.`
  );
}

/**
 * Sentry patterns for cap refusals.
 *
 * A cap refusal is expected behaviour, not a defect, so it must not open an issue. It
 * lives here rather than in `sentry-ignore-patterns.ts` so that anyone rewording
 * `workspaceCapRefusal` sees the matcher in the same file — the previous arrangement had
 * the pattern `/Workspace limit reached/i` sitting three files away, matching the
 * renderer's rebuilt label and NOT the message the handler actually threw, so the drop
 * never fired for the skills cap at all.
 */
export const WORKSPACE_CAP_SENTRY_PATTERNS: RegExp[] = [
  /workspace limit reached/i,
];

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
export function workspaceCapClause(kind: WorkspaceCapKind): string {
  const noun = CAP_NOUN[kind];
  const max = CAP_MAX[kind];
  return (
    `WORKSPACE LIMIT: ${max} ${noun} per workspace — ` +
    `\`list\` reports the count and whether there is room. ` +
    `If a create is refused by this cap the workspace is full, NOT broken: ` +
    `say which limit was hit instead of retrying, and remove one to add another. ` +
    `This is not a plan limit and there is no tier that raises it.`
  );
}
