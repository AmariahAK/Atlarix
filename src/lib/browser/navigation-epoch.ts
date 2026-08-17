/**
 * Which PAGE LOAD an entry belongs to.
 *
 * Console and Network both group by browser tab, which is not the same question
 * as "which page produced this". A tab that goes youtube.com → github.com is one
 * tabId with two pages' worth of output in it, and because navigating
 * deliberately clears nothing (comparing two loads is often the whole point),
 * that output accumulates:
 *
 *  - the Console card carried a navigation divider that split nothing, and was
 *    labelled with the LATEST url — so a card reading "github.com" contained
 *    YouTube's console, and "Send to Atlarix" shipped both;
 *  - Network had no navigation marker at all, so there was not even a divider to
 *    read the boundary from.
 *
 * A monotonic per-tab counter, bumped at the single `did-navigate` handler that
 * already emits the console marker, gives both streams the same boundary from
 * one source. Entries are stamped at RECORD time, because "which page was
 * loaded when this happened" cannot be recovered afterwards.
 *
 * Tab ids are globally unique (`nextTabId` in browser_view_manager never
 * resets), so a flat map keyed by tab id is safe across windows.
 */

export type NavigationEpoch = {
  /** Monotonic per tab. 0 is the first load, before any `did-navigate`. */
  seq: number;
  /** The url that produced this epoch — the label a person recognises. */
  pageUrl?: string;
};

const epochByTab = new Map<number, NavigationEpoch>();

/** The tab's current epoch. Reads never create state — a tab that has navigated nowhere is epoch 0. */
export function currentNavigationEpoch(tabId: number): NavigationEpoch {
  return epochByTab.get(tabId) ?? { seq: 0 };
}

/**
 * Advance the tab to a new page. Call ONLY from the real navigation event, not
 * from in-page route changes: `did-navigate-in-page` fires on every SPA route
 * change and would shatter a single-page app into a card per click.
 */
export function beginNavigationEpoch(tabId: number, pageUrl: string): NavigationEpoch {
  const next: NavigationEpoch = {
    seq: currentNavigationEpoch(tabId).seq + 1,
    pageUrl,
  };
  epochByTab.set(tabId, next);
  return next;
}

/** Drop a closed tab's epoch so the map does not grow for the life of the app. */
export function clearNavigationEpoch(tabId: number): void {
  epochByTab.delete(tabId);
}

/** Test seam — module state is process-global. */
export function __resetNavigationEpochsForTests(): void {
  epochByTab.clear();
}

/**
 * Split entries into one group per (tab, page load), preserving arrival order.
 *
 * Shared by both panels so they can never disagree about where a page boundary
 * is. Entries with no `navSeq` — recorded before the first navigation, or
 * persisted by an older version — collapse into epoch 0 rather than vanishing:
 * a grouping that silently drops entries would reintroduce exactly the
 * "whose output is this?" confusion the cards exist to remove.
 */
export function groupByNavigationEpoch<T>(
  entries: readonly T[],
  read: (entry: T) => { tabId: number | null; navSeq?: number; pageUrl?: string },
): Array<{
  tabId: number | null;
  navSeq: number;
  pageUrl?: string;
  entries: T[];
}> {
  const groups = new Map<
    string,
    { tabId: number | null; navSeq: number; pageUrl?: string; entries: T[] }
  >();
  for (const entry of entries) {
    const { tabId, navSeq, pageUrl } = read(entry);
    const seq = navSeq ?? 0;
    const key = `${tabId ?? "none"}:${seq}`;
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
      // First non-empty url wins: later entries in the same load carry the same
      // page, and an entry recorded before the stamp landed carries none.
      existing.pageUrl ??= pageUrl;
    } else {
      groups.set(key, { tabId, navSeq: seq, pageUrl, entries: [entry] });
    }
  }
  return [...groups.values()];
}
