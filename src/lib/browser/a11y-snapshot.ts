/**
 * Accessibility snapshot of a browser page — the `agent-browser` technique,
 * here bound to Electron's WebContentsView.
 *
 * An injected DOM walker tags elements with a `data-atlarix-ref` ("e1", "e2", …)
 * and returns a compact list. The model reads this (far lighter than a
 * screenshot or full DOM) and acts via `browser({ action, ref })`, resolving the
 * ref by attribute instead of a brittle CSS selector.
 *
 * WHAT LIVES WHERE (v14.46). The scripts themselves — the walker, the ref
 * registry, the find ranker — moved to `./page-scripts`, which has zero imports
 * so the Chrome extension can run the SAME strings in a content script. That
 * shared file is what makes one tool contract true across two backends; this
 * file is now only the Electron transport plus the text formatters the model
 * reads. Change ranking or ref semantics THERE, not here.
 *
 * Runs through the same `executeJavaScript(script, true)` channel as the other
 * browser tools. Model input reaches the script ONLY via JSON.stringify.
 */

import { formatFind, formatSnapshot } from "./a11y-format";
import {
  findScript,
  snapshotScript,
  type A11yFilter,
  type A11yFindResult,
  type A11ySnapshot,
} from "./page-scripts";

export type {
  A11yElement,
  A11yFilter,
  A11yFindMatch,
  A11yFindResult,
  A11ySnapshot,
} from "./page-scripts";

/** Run the walker in a page; null on failure. */
export async function getA11ySnapshot(
  wc: Electron.WebContents,
  filter: A11yFilter = "interactive",
): Promise<A11ySnapshot | null> {
  try {
    const result = (await wc.executeJavaScript(
      snapshotScript(filter),
      true,
    )) as A11ySnapshot | null;
    if (!result || !Array.isArray(result.elements)) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Render the snapshot as compact text the model reads (one line per element).
 *
 * The implementation moved to `./a11y-format`, which has zero imports, so the
 * Chrome extension renders a page with the SAME code instead of a second
 * formatter that would slowly describe pages differently. Re-exported from here
 * — under this name, with the desktop's `browser(...)` vocabulary as the
 * default — so `browser.ts` and its tests are untouched.
 */
export function formatA11ySnapshot(snap: A11ySnapshot): string {
  return formatSnapshot(snap);
}

export async function findA11yElements(
  wc: Electron.WebContents,
  query: string,
): Promise<A11yFindResult | null> {
  try {
    const result = (await wc.executeJavaScript(
      findScript(query),
      true,
    )) as A11yFindResult | null;
    if (!result || !Array.isArray(result.matches)) return null;
    return result;
  } catch {
    return null;
  }
}

export function formatA11yFind(res: A11yFindResult): string {
  return formatFind(res);
}
