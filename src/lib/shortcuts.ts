/**
 * Every keyboard shortcut Atlarix has, described once.
 *
 * WHAT THIS IS AND IS NOT
 * -----------------------
 * A DESCRIPTION table, not a dispatch table. The handlers stay exactly where they are;
 * this file is what the tips line and the Help sheet read so neither has to hand-copy a
 * chord. Two things forced that choice rather than table-driven dispatch:
 *
 *  - **Dispatch could not be a single source of truth even in principle.** `Cmd/Ctrl+W`
 *    is an Electron accelerator in the MAIN process (`main.ts`), and Enter / Shift+Enter
 *    is component-local input semantics in the composer. A renderer dispatch table would
 *    own six of these while *presenting* as complete — the same failure as a drifting
 *    description, only harder to notice. Description is the one thing all of them share.
 *  - **The work-mode cycle's stale-closure bug already shipped once.** Table-driven
 *    dispatch pressures you to hoist handlers out of `usePanelShortcuts`'s `useEffect`,
 *    which is exactly how that returns. `main.ts` makes the same argument for the other
 *    direction, where a renderer handler fighting an accelerator "left the behaviour
 *    depending on which of the two won".
 *
 * HOW IT STAYS HONEST
 * -------------------
 * `src/__tests__/renderer/shortcuts-table.test.tsx` mounts the real hook and dispatches
 * events SYNTHESISED FROM THESE ROWS, so the table is the input and the handler's
 * observable effect is the assertion. It never parses the handler. A row that describes a
 * chord the handler does not listen for is a red test, not a wrong keystroke in front of
 * a user — which is the only thing that makes a description table safe to publish.
 *
 * A description table with no such test is worse than no table at all.
 */

/** Platform-neutral. `mod` is Cmd on macOS and Ctrl elsewhere, resolved at render time. */
export type ShortcutCombo = {
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Matched case-insensitively against `KeyboardEvent.key`. */
  key: string;
};

/**
 * Who listens for the chord. Determines whether the conformance test can prove it.
 *
 * `panel` rows are dispatched against the real hook. The others cannot be: `menu` lives
 * in the main process and `composer` needs a component render rather than a hook, so
 * they are marked and the test asserts on that exemption list — the exemptions cannot
 * grow silently.
 */
export type ShortcutOwner =
  | "panel"
  | "sidebar"
  | "app-search"
  | "menu"
  | "composer";

export type KeyboardShortcut = {
  id: string;
  combo: ShortcutCombo;
  /** Imperative, user-facing. Used verbatim in Help. */
  label: string;
  owner: ShortcutOwner;
  /**
   * Where the shortcut actually works, when that is narrower than "anywhere".
   *
   * The table is the only place preconditions are written down, and that is most of why
   * it earns its keep beyond deduplication: a tip that advertises a chord which no-ops
   * in the user's current context is worse than no tip.
   */
  scope?: string;
  /**
   * `hidden` rows are NOT advertised in tips or Help. They exist so the table records a
   * shortcut we know about rather than letting its absence imply it does not exist.
   */
  status: "advertised" | "hidden";
};

export const SHORTCUTS: readonly KeyboardShortcut[] = [
  {
    id: "toggle-right-panel",
    combo: { mod: true, key: "b" },
    label: "Show or hide the right panel",
    owner: "panel",
    status: "advertised",
  },
  {
    id: "cycle-work-mode",
    combo: { shift: true, key: "Tab" },
    label: "Cycle work mode — Explore, Plan, Build, Debug, Review",
    owner: "panel",
    // Outside a workspace chat the handler shows "Work modes are available in workspace
    // chats" and does nothing, so advertising it there would be a lie.
    scope: "workspace chats",
    status: "advertised",
  },
  {
    id: "change-model",
    combo: { mod: true, key: "j" },
    label: "Change the model mid-chat",
    owner: "panel",
    status: "advertised",
  },
  {
    id: "prev-panel-tab",
    combo: { mod: true, key: "i" },
    label: "Previous panel tab",
    owner: "panel",
    // The handler returns early below two tabs, so there is nothing to move between.
    scope: "two or more panel tabs",
    status: "advertised",
  },
  {
    id: "next-panel-tab",
    combo: { mod: true, key: "o" },
    label: "Next panel tab",
    owner: "panel",
    scope: "two or more panel tabs",
    status: "advertised",
  },
  {
    id: "toggle-left-sidebar",
    combo: { mod: true, key: "/" },
    label: "Show or hide the left sidebar",
    owner: "sidebar",
    status: "advertised",
  },
  {
    /**
     * WAS KNOWN BROKEN until the dialog was hoisted to the app root.
     *
     * The listener lives inside `AppSearchDialog`, which used to be mounted only from
     * `AppList` — and `AppList` returns null unless the Apps sidebar item is showing, so
     * the chord did nothing most of the time. That is why this row was `hidden`: it was
     * real enough to record, not reliable enough to advertise.
     *
     * `components/GlobalAppSearch.tsx` now mounts it in `app/layout.tsx` beside the other
     * always-live dialogs, so the chord works on every route and the row can be honest.
     */
    id: "app-search",
    combo: { mod: true, key: "k" },
    label: "Search workspaces",
    owner: "app-search",
    status: "advertised",
  },
  {
    /**
     * A NATIVE ACCELERATOR, registered on the File menu in `main.ts`, not a
     * renderer keydown. The rail's "New window" button had no chord at all, and
     * an OS accelerator is the right instrument for this one: it fires with the
     * caret anywhere, including inside the composer, and File is where the
     * platform convention puts New Window.
     */
    id: "new-window",
    combo: { mod: true, key: "n" },
    label: "Open a new window",
    owner: "menu",
    status: "advertised",
  },
  {
    id: "close-tab-or-window",
    combo: { mod: true, key: "w" },
    label: "Close the window",
    owner: "menu",
    status: "advertised",
  },
  {
    id: "send-message",
    combo: { key: "Enter" },
    label: "Send your message",
    owner: "composer",
    status: "advertised",
  },
  {
    id: "newline",
    combo: { shift: true, key: "Enter" },
    label: "Start a new line instead of sending",
    owner: "composer",
    status: "advertised",
  },
];

/**
 * Is this a Mac?
 *
 * Extracted verbatim from `usePanelShortcuts`, which now calls it — the minimum coupling
 * that stops the table's platform half being a second copy of the same logic. Read at
 * call time, so there is no closure to go stale.
 *
 * `navigator.platform` is deprecated and empty in some environments; the non-Mac branch
 * is therefore the fallback as well as a real answer, and the conformance test pins both.
 */
export function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.platform?.toLowerCase().startsWith("mac")
  );
}

/** `⌘J` on a Mac, `Ctrl+J` elsewhere. */
export function formatCombo(combo: ShortcutCombo, isMac: boolean): string {
  const parts: string[] = [];
  if (combo.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (combo.shift) parts.push(isMac ? "⇧" : "Shift");
  if (combo.alt) parts.push(isMac ? "⌥" : "Alt");
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  // Mac convention stacks modifiers without separators; elsewhere they are joined.
  return isMac ? parts.join("") : parts.join("+");
}

/** The rows tips and Help may show. */
export function advertisedShortcuts(): KeyboardShortcut[] {
  return SHORTCUTS.filter((s) => s.status === "advertised");
}
