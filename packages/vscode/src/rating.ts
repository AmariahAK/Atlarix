/**
 * One request for a rating, ever, after Atlarix has done some real work for
 * someone. Ratings and installs are what the Marketplace and Open VSX rank by;
 * a new extension with none sorts last in every search, whatever its listing
 * says. No vscode import, so the rules are tested on their own.
 */

/** Finished turns before we ask: enough to have formed an opinion. */
export const ASK_AFTER_TURNS = 5;

export interface RatingState {
  turns: number;
  asked: boolean;
}

/** Count a finished turn; true exactly once, when it is time to ask. */
export function noteTurn(state: RatingState): { state: RatingState; ask: boolean } {
  if (state.asked) return { state, ask: false };
  const turns = state.turns + 1;
  if (turns < ASK_AFTER_TURNS) return { state: { turns, asked: false }, ask: false };
  return { state: { turns, asked: true }, ask: true };
}

/**
 * Where to rate: the Marketplace's review form for VS Code, Open VSX for the
 * editors that install from it (Cursor, Kiro, Windsurf, VSCodium…).
 */
export function ratingUrl(appName: string): string {
  return /^Visual Studio Code/i.test(appName)
    ? "https://marketplace.visualstudio.com/items?itemName=atlarix.atlarix&ssr=false#review-details"
    : "https://open-vsx.org/extension/atlarix/atlarix/reviews";
}
