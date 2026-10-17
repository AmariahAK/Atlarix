/**
 * The terminal tab's title: a pulsing diamond while Atlarix works, so a busy
 * session is visible from another tab (owner, 2026-10-04: "an animation that
 * runs when atlarix is working in a tab"). Static otherwise: the session's
 * title, or what it is waiting for. Waiting on you gets its own mark, <!>: a
 * plain ◆ read the same as idle from another tab (owner, 2026-10-16: "an icon
 * in the terminal that atlarix needs your permission"; symbols, never emoji).
 */
export const TAB_FRAMES = ["◇", "◈", "◆", "◈"] as const;
export const TAB_FRAME_MS = 300;

export type TabState = { busy: boolean; waiting: boolean; title?: string | null };

/** No control characters (they would end the escape sequence), at most 60 chars. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  return s.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 60);
}

export function tabTitle(state: TabState, frame: number): string {
  const name = state.title ? clean(state.title) : "atlarix";
  if (state.waiting) return `<!> needs you · ${name}`;
  if (state.busy) return `${TAB_FRAMES[frame % TAB_FRAMES.length]} ${name}`;
  return `◆ ${name}`;
}

/** OSC 0: the tab and window title. An empty title gives the terminal its own back. */
export function titleSequence(title: string): string {
  return `\x1b]0;${title}\x07`;
}
