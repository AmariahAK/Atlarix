/**
 * When a session recap is due. Pure and import-free: the CLI, the app, the
 * Chrome side panel and the VS Code extension all decide with this one rule.
 *
 * A recap is the one line you see coming back to a session you stepped away
 * from. It is due when all of these hold:
 *   - recaps are on (the shared `sessionRecap` setting);
 *   - the user is away (the window, terminal or panel is not in front);
 *   - nothing is running;
 *   - the session has at least three finished turns (a short exchange needs no summary);
 *   - three minutes have passed since the last turn finished;
 *   - there has been a turn since the last recap (never two in a row);
 *   - on the free share of Atlarix Auto, the share is not nearly used up.
 */

export interface RecapClock {
  completedTurns: number;
  /** ms epoch of the last finished turn. */
  lastTurnEndedAt: number | null;
  /** `completedTurns` when the last recap was made; -1 before any. */
  recappedAfterTurn: number;
}

export interface RecapInputs extends RecapClock {
  enabled: boolean;
  /** The user is looking at this session right now. */
  present: boolean;
  busy: boolean;
  now: number;
  awayMs?: number;
  minTurns?: number;
  /** Free Auto with little of today's share left: a recap would spend what a real turn needs. */
  nearFreeLimit?: boolean;
}

export type RecapDecision = { kind: "never" } | { kind: "wait"; ms: number } | { kind: "now" };

export const RECAP_AWAY_MS = 3 * 60_000;
export const RECAP_MIN_TURNS = 3;
export const RECAP_MAX_CHARS = 400;
/** Below this share of today's free Auto (0–100) recaps stop. Same line as the app's low-share warning. */
export const RECAP_FREE_FLOOR_PERCENT = 20;

export function recapDecision(i: RecapInputs): RecapDecision {
  if (!i.enabled || i.present || i.busy || i.nearFreeLimit) return { kind: "never" };
  if (i.completedTurns < (i.minTurns ?? RECAP_MIN_TURNS)) return { kind: "never" };
  if (i.recappedAfterTurn >= i.completedTurns) return { kind: "never" };
  if (i.lastTurnEndedAt == null) return { kind: "never" };
  const left = (i.awayMs ?? RECAP_AWAY_MS) - (i.now - i.lastTurnEndedAt);
  return left > 0 ? { kind: "wait", ms: left } : { kind: "now" };
}

/** Whether today's free Auto share is too low to spend on a recap. */
export function nearFreeLimit(status: { billing?: string | null; freeRemaining?: number | null } | null | undefined): boolean {
  if (!status || status.billing !== "free") return false;
  return typeof status.freeRemaining === "number" && status.freeRemaining < RECAP_FREE_FLOOR_PERCENT;
}

/** One line, at most RECAP_MAX_CHARS, no markdown furniture. */
export function clampRecap(text: string): string {
  const line = text
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(recap|summary)\s*:\s*/i, "")
    .trim();
  if (line.length <= RECAP_MAX_CHARS) return line;
  const cut = line.slice(0, RECAP_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > RECAP_MAX_CHARS * 0.7 ? space : cut.length).trimEnd()}…`;
}
