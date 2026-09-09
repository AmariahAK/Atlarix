/**
 * Grouping the console by PAGE LOAD.
 *
 * Two bugs, one grouping. The first: a second tab's output read as the page
 * under test's failure — so a grouping that silently drops anything would
 * reintroduce it by making entries vanish instead of merely being mislabelled.
 *
 * The second, found in use: grouping by TAB alone was not enough. Navigating
 * deliberately clears nothing, so one tab that went youtube.com → github.com
 * produced a single card TITLED "github.com" that also held YouTube's console —
 * and "Send to Atlarix" on that card shipped both pages. The navigation divider
 * split nothing.
 */

import { describe, expect, it } from "vitest";
import { groupByTab } from "@/components/preview_panel/PageConsole";
import type { PageConsoleEntry } from "@/atoms/sourceAtoms";

function entry(over: Partial<PageConsoleEntry> = {}): PageConsoleEntry {
  return {
    type: "console-error",
    level: "log",
    message: "hello",
    timestamp: 1,
    ...over,
  } as PageConsoleEntry;
}

describe("groupByTab", () => {
  it("keeps each tab separate and preserves order within a tab", () => {
    const groups = groupByTab([
      entry({ tabId: 1, message: "a1" }),
      entry({ tabId: 2, message: "b1" }),
      entry({ tabId: 1, message: "a2" }),
    ]);
    expect(groups).toHaveLength(2);
    const tab1 = groups.find((g) => g.tabId === 1)!;
    expect(tab1.entries.map((e) => e.message)).toEqual(["a1", "a2"]);
  });

  it("splits one tab into a card per page load, each named for its own page", () => {
    const groups = groupByTab([
      entry({
        tabId: 1,
        navSeq: 1,
        pageUrl: "https://youtube.com",
        type: "navigated",
        url: "https://youtube.com",
      }),
      entry({
        tabId: 1,
        navSeq: 1,
        pageUrl: "https://youtube.com",
        message: "from youtube",
      }),
      entry({
        tabId: 1,
        navSeq: 2,
        pageUrl: "https://github.com",
        type: "navigated",
        url: "https://github.com",
      }),
      entry({
        tabId: 1,
        navSeq: 2,
        pageUrl: "https://github.com",
        message: "from github",
      }),
    ]);

    expect(groups).toHaveLength(2);
    // Each card is titled with the page that produced ITS contents — the bug was
    // a card reading "github.com" while holding YouTube's output.
    expect(groups[0].label).toBe("https://youtube.com");
    expect(groups[1].label).toBe("https://github.com");
    // And a send scoped to one card can no longer carry the other page.
    expect(groups[0].entries.map((e) => e.message)).toContain("from youtube");
    expect(groups[0].entries.map((e) => e.message)).not.toContain(
      "from github",
    );
    // Nothing was thrown away on navigate; both pages are still present.
    expect(groups[0].entries.length + groups[1].entries.length).toBe(4);
  });

  /**
   * The stamp comes from main, but the boundary must not DEPEND on it: capture
   * can begin mid-session, and older entries carry none. The markers in the
   * stream are enough on their own.
   */
  it("derives the split from navigation markers when no epoch was stamped", () => {
    const groups = groupByTab([
      entry({ tabId: 1, type: "navigated", url: "https://youtube.com" }),
      entry({ tabId: 1, message: "from youtube" }),
      entry({ tabId: 1, type: "navigated", url: "https://github.com" }),
      entry({ tabId: 1, message: "from github" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("https://youtube.com");
    expect(groups[1].label).toBe("https://github.com");
  });

  it("keeps two tabs on the same page load apart", () => {
    const groups = groupByTab([
      entry({ tabId: 1, navSeq: 1, pageUrl: "https://a.dev", message: "a" }),
      entry({ tabId: 2, navSeq: 1, pageUrl: "https://b.dev", message: "b" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label).sort()).toEqual([
      "https://a.dev",
      "https://b.dev",
    ]);
  });

  it("never loses an entry that has no tab id", () => {
    const groups = groupByTab([
      entry({ message: "orphan" }),
      entry({ tabId: 1 }),
    ]);
    const orphans = groups.find((g) => g.tabId === null)!;
    expect(orphans.label).toBe("Unattributed");
    expect(orphans.entries).toHaveLength(1);
  });

  it("falls back to the tab number when a tab never reported a navigation", () => {
    // Capture can begin after the tab loaded, so there may be no marker to read.
    const groups = groupByTab([entry({ tabId: 7 })]);
    expect(groups[0].label).toBe("Tab 7");
  });
});
