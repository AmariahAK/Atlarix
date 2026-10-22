/**
 * One session sets another's mode and/or model (send_message's `mode` and
 * `model`, owner, 2026-10-22). Only the mode and the model: never permission
 * rules or grants. Only models this user has set up, from any source (Atlarix
 * Auto and Core, their own keys, custom and local providers). For that session
 * only, from its next turn, with a line saying who changed it.
 */
export type PeerMode = "build" | "ask" | "plan" | "debug" | "review";

/** The names people see ("ask" is Explore everywhere in the UI). */
export const MODE_NAMES: Record<PeerMode, string> = {
  build: "Build",
  ask: "Explore",
  plan: "Plan",
  debug: "Debug",
  review: "Review",
};

/** A mode as typed: its name or its id, any case. */
export function parseMode(s: unknown): PeerMode | null {
  const t = String(s ?? "").trim().toLowerCase();
  if (t === "explore") return "ask";
  return (Object.keys(MODE_NAMES) as PeerMode[]).includes(t as PeerMode) ? (t as PeerMode) : null;
}

/*
 * Any mode applies directly, Build included, and a message with it may start
 * the session's turn (owner, 2026-10-22, after QA asked about a session talked
 * into it by untrusted content): the prompt already tells models not to act on
 * untrusted data, and each session's own permission rules stay its boundary
 * (a write or command still asks there, unless the user allows it).
 */

export interface ModelChoiceLike {
  provider: string;
  name: string;
  label: string;
}

/**
 * The model asked for, among the ones this user has set up: by its name as
 * listed, `provider/name`, or its id. Anything else is refused with the list.
 */
export function matchModel<T extends ModelChoiceLike>(asked: string, options: readonly T[]): T | { error: string } {
  const a = asked.trim().toLowerCase();
  const hit =
    options.find((o) => o.label.toLowerCase() === a) ??
    options.find((o) => `${o.provider}/${o.name}`.toLowerCase() === a) ??
    options.find((o) => o.name.toLowerCase() === a);
  if (hit) return hit;
  const names = options.map((o) => o.label).join(", ");
  return { error: `"${asked}" is not a model this user has set up${names ? `. Models you can set: ${names}` : ""}` };
}

/** The line the changed session shows: "Mode set to Review by Rix. From the next turn." */
export function settingsNotice(change: { mode?: PeerMode; model?: string }, sender: string): string {
  const by = sender.trim() || "another session";
  if (change.mode && change.model) {
    return `Mode set to ${MODE_NAMES[change.mode]} and model to ${change.model} by ${by}. From the next turn.`;
  }
  if (change.mode) return `Mode set to ${MODE_NAMES[change.mode]} by ${by}. From the next turn.`;
  return `Model set to ${change.model} by ${by}. From the next turn.`;
}
