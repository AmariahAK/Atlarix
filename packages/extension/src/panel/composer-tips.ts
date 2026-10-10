/**
 * What the composer says when it is empty.
 *
 * IT REPLACED A PLACEHOLDER, AND THAT IS THE POINT. "Ask about this page…"
 * answered one question and then sat there forever on the control the user
 * looks at most — and it was also wrong by omission, because the panel opens
 * tabs, searches, fills forms and reads past conversations, none of which is
 * "this page".
 *
 * WHAT EARNS A LINE HERE. Only a capability a user has NO WAY to discover from
 * a text box. "Ask me anything" teaches nothing; "I can open a tab you have not
 * opened" teaches something that is otherwise invisible until the day someone
 * happens to ask for it. If a tip would still be true of a plain chat box, it
 * does not belong.
 *
 * TWO RULES THE CALLER ENFORCES, both about not being annoying:
 *   - never while someone is typing (the placeholder is invisible then anyway,
 *     but the input's value is the only honest signal that they are mid-thought)
 *   - between turns, not on a timer. A string that changes while you are reading
 *     it reads as a glitch.
 *
 * No inline script and no inline style — `sidepanel.html` says so at the top,
 * and MV3's default `script-src 'self'` means it is a build error, not a style
 * preference. Rotation is this module plus one property write.
 */

/**
 * The pool, most-useful first.
 *
 * Order matters only for the FIRST impression: `firstTip()` returns `TIPS[0]`,
 * so index 0 should be the one thing worth knowing if a user reads exactly one.
 * Everything after that is shuffled through by `nextTip`.
 */
export const TIPS: readonly string[] = [
  "Ask about this page — or give me a URL and I'll open it",
  "I can open and read a tab you haven't opened yet",
  "I fill forms, but I never submit them — that part stays yours",
  "Ask what we discussed last week; I can search past conversations",
  "Drop a CSV or an image here and ask about it",
  "Ask me to remember something and I'll still know it next week",
  "I can search the web and read the results, not just list them",
  "Close my tab group at any time to stop me",
  "Your editor or terminal can hand me browser work",
];

/** The tip a freshly-opened panel shows. */
export function firstTip(): string {
  return TIPS[0];
}

/**
 * The next tip, given the one on screen.
 *
 * Deliberately NOT random: a random pick repeats roughly one time in eight,
 * and a "rotation" that shows the same string twice reads as broken rather than
 * as chance. Advancing by one is predictable, covers the whole pool, and needs
 * no state beyond what is already on the element.
 *
 * An unrecognised `current` (the HTML's own default on first load, or a tip
 * deleted in a later release) starts the cycle rather than throwing.
 */
export function nextTip(current: string): string {
  const i = TIPS.indexOf(current);
  if (i < 0) return TIPS[0];
  return TIPS[(i + 1) % TIPS.length];
}

/**
 * Whether the composer may change its tip right now.
 *
 * `value` is the textarea's CURRENT text, not a draft flag: a placeholder swap
 * under someone who has typed and paused is the exact interruption the rotation
 * rule exists to avoid, and emptiness is the only signal available that does
 * not require tracking focus.
 */
export function mayRotate(state: { value: string; running: boolean }): boolean {
  return state.value.trim().length === 0 && !state.running;
}
