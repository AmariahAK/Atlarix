/**
 * Browser session recorder — a verifiable artifact of what the agent did in the
 * built-in browser (navigations, clicks, fills, screenshots, reads), in order.
 *
 * Antigravity-style "here's a recording proving the feature works": each browser
 * tool appends a step here, and `formatBrowserRecordingArtifact` renders a
 * reviewable walkthrough surfaced alongside screenshots. In-memory, per chat,
 * bounded — no DB, no renderer dependency.
 */

export type BrowserActionType =
  | "navigate"
  | "read"
  | "screenshot"
  | "click"
  | "fill";

export interface BrowserAction {
  type: BrowserActionType;
  /** Short human description (selector, url, value preview). */
  detail: string;
  /** Page URL at the time of the action, when known. */
  url?: string;
  ts: number;
}

/** Cap steps per chat so a long automation can't grow unbounded. */
const MAX_STEPS = 200;
const byChat = new Map<number, BrowserAction[]>();

export function recordBrowserAction(
  chatId: number | undefined,
  type: BrowserActionType,
  detail: string,
  url?: string,
): void {
  if (chatId == null) return;
  const steps = byChat.get(chatId) ?? [];
  steps.push({ type, detail: detail.slice(0, 300), url, ts: Date.now() });
  if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);
  byChat.set(chatId, steps);
}

export function getBrowserRecording(
  chatId: number | undefined,
): BrowserAction[] {
  if (chatId == null) return [];
  return byChat.get(chatId) ?? [];
}

export function clearBrowserRecording(chatId: number | undefined): void {
  if (chatId == null) return;
  byChat.delete(chatId);
}

/** Render the session as a reviewable markdown walkthrough, or null if empty. */
export function formatBrowserRecordingArtifact(
  chatId: number | undefined,
): string | null {
  const steps = getBrowserRecording(chatId);
  if (steps.length === 0) return null;
  const lines = steps.map((s, i) => {
    const where = s.url ? `  (${s.url})` : "";
    return `${i + 1}. **${s.type}** — ${s.detail}${where}`;
  });
  return `## Browser session walkthrough (${steps.length} step${steps.length === 1 ? "" : "s"})\n${lines.join("\n")}`;
}
