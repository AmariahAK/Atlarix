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
  /** "Atlarix", or the provider's own name: tells two models with one label apart. */
  providerName?: string;
}

/**
 * Each model's name as list_sessions shows it and send_message takes it: its
 * label, or "label (provider)" when two of them share a label (the same model
 * through two providers, QA E6).
 */
export function modelNames<T extends ModelChoiceLike>(options: readonly T[]): Array<{ name: string; option: T }> {
  const count = new Map<string, number>();
  for (const o of options) count.set(o.label.toLowerCase(), (count.get(o.label.toLowerCase()) ?? 0) + 1);
  return options.map((o) => ({
    name: (count.get(o.label.toLowerCase()) ?? 0) > 1 ? `${o.label} (${o.providerName || o.provider})` : o.label,
    option: o,
  }));
}

/**
 * The model asked for, among the ones this user has set up: by its name as
 * listed, `provider/name`, or its id. A name two models share is refused with
 * both forms, never resolved to the first; anything else is refused with the list.
 */
export function matchModel<T extends ModelChoiceLike>(asked: string, options: readonly T[]): T | { error: string } {
  const a = asked.trim().toLowerCase();
  const named = modelNames(options);
  const listed = named.map((n) => n.name).join(", ");
  const exact = named.find((n) => n.name.toLowerCase() === a);
  if (exact) return exact.option;
  const byPath = options.find((o) => `${o.provider}/${o.name}`.toLowerCase() === a);
  if (byPath) return byPath;
  const loose = options.filter((o) => o.label.toLowerCase() === a || o.name.toLowerCase() === a);
  if (loose.length === 1) return loose[0]!;
  if (loose.length > 1) {
    const forms = named.filter((n) => loose.includes(n.option)).map((n) => `"${n.name}"`).join(" or ");
    return { error: `"${asked}" names more than one model: say ${forms}` };
  }
  return { error: `"${asked}" is not a model this user has set up${listed ? `. Models you can set: ${listed}` : ""}` };
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

/** A session's answer to another's plan awaiting approval (item 11). */
export type PeerPlanAction = "approve" | "reject" | "update";

export function parsePlanAction(s: unknown): PeerPlanAction | null {
  const t = String(s ?? "").trim().toLowerCase();
  return t === "approve" || t === "reject" || t === "update" ? t : null;
}

/** "Plan approved by Rix. Building it." */
export function planNotice(action: PeerPlanAction, sender: string): string {
  const by = sender.trim() || "another session";
  if (action === "approve") return `Plan approved by ${by}. Building it.`;
  if (action === "reject") return `Plan rejected by ${by}.`;
  return `Plan updated by ${by}. It's waiting for approval.`;
}
