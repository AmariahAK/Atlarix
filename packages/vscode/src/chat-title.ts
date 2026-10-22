/**
 * The chat's name on its editor tab and on the sidebar view's header (owner,
 * 2026-10-22): the session's title as it changes (auto-title, a rename, a
 * re-title after /undo, one from another surface), nothing until it has one,
 * short enough for a tab. No vscode import, so the rule is tested on its own.
 */
export const PANEL_TITLE_MAX = 32;

/** What to show, or null for a chat with no name yet ("Atlarix" on a tab, nothing in the sidebar). */
export function panelTitle(title: string | null | undefined): string | null {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t || /^(untitled|new chat|new conversation)$/i.test(t)) return null;
  return t.length > PANEL_TITLE_MAX ? `${t.slice(0, PANEL_TITLE_MAX - 1).trimEnd()}…` : t;
}
