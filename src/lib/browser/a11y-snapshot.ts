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

/** Render the snapshot as compact text the model reads (one line per element). */
export function formatA11ySnapshot(snap: A11ySnapshot): string {
  const lines = snap.elements.map((e) => {
    if (e.kind === "content") {
      return `[${e.ref}] ${e.role} — ${e.text ?? ""}`;
    }
    const bits = [`[${e.ref}] ${e.role}`];
    if (e.name) bits.push(`"${e.name}"`);
    if (e.placeholder) bits.push(`placeholder="${e.placeholder}"`);
    if (e.value) bits.push(`value="${e.value}"`);
    return bits.join(" ");
  });
  const combined = snap.filter === "all";
  const total = snap.total ?? snap.count;
  // Report the REAL total when capped — "capped at 200" told the model the cap,
  // not how much it was missing.
  const hasScroll = (snap.scrollMax ?? 0) > 0;
  const truncNote = snap.truncated
    ? ` (showing ${snap.count} of ${total} — narrow with a more specific query via browser({action:"find"})${hasScroll ? " or scroll down to trigger lazy-loaded content" : ""})`
    : "";
  const what = combined
    ? `${snap.count} element(s): page content + interactive controls`
    : `${snap.count} interactive element(s)`;
  const viewportNote = snap.viewport ? ` Rendered at ${snap.viewport}.` : "";
  let scrollNote = "";
  if (hasScroll) {
    const y = snap.scrollY ?? 0;
    const max = snap.scrollMax!;
    const atEnd = y >= max - 2;
    if (y <= 2)
      scrollNote = ` Scroll: top of page (0 of ${max}px — scroll down for more).`;
    else if (atEnd) scrollNote = ` Scroll: bottom reached (${y} of ${max}px).`;
    else
      scrollNote = ` Scroll: ${y} of ${max}px (midway — content above and below).`;
  }
  const header =
    `Page read — ${what}${truncNote}.${viewportNote}${scrollNote}` +
    ` Act on any ref with browser (e.g. action:"click", ref:"e3"). Refs are stable for this page.`;
  return `${header}\n${lines.join("\n")}`;
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
  if (res.matches.length === 0) {
    return `No elements matched "${res.query}". Try fewer/different words, or read the page with browser_inspect.`;
  }
  const lines = res.matches.map(
    (m) => `[${m.ref}] ${m.role}${m.name ? ` "${m.name}"` : ""}`,
  );
  const more = res.truncated
    ? ` More matches exist (${res.total} total) — narrow the query.`
    : "";
  return (
    `${res.matches.length} match(es) for "${res.query}", best first.${more}` +
    ` Act on a ref with browser (e.g. action:"click", ref).\n${lines.join("\n")}`
  );
}
