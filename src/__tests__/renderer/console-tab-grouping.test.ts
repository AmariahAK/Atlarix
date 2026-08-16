/**
 * Grouping the console by browser tab.
 *
 * The bug this exists for: a second tab's output read as the page under test's
 * failure. A grouping that silently drops anything would reintroduce exactly
 * that, by making entries vanish instead of merely being mislabelled.
 */

import { describe, expect, it } from 'vitest';
import { groupByTab } from '@/components/preview_panel/PageConsole';
import type { PageConsoleEntry } from '@/atoms/sourceAtoms';

function entry(over: Partial<PageConsoleEntry> = {}): PageConsoleEntry {
  return {
    type: 'console-error',
    level: 'log',
    message: 'hello',
    timestamp: 1,
    ...over,
  } as PageConsoleEntry;
}

describe('groupByTab', () => {
  it('keeps each tab separate and preserves order within a tab', () => {
    const groups = groupByTab([
      entry({ tabId: 1, message: 'a1' }),
      entry({ tabId: 2, message: 'b1' }),
      entry({ tabId: 1, message: 'a2' }),
    ]);
    expect(groups).toHaveLength(2);
    const tab1 = groups.find((g) => g.tabId === 1)!;
    expect(tab1.entries.map((e) => e.message)).toEqual(['a1', 'a2']);
  });

  it('names a card from the tab\'s most recent navigation', () => {
    const groups = groupByTab([
      entry({ tabId: 1, type: 'navigated', url: 'https://youtube.com' }),
      entry({ tabId: 1, message: 'from youtube' }),
      entry({ tabId: 1, type: 'navigated', url: 'https://github.com' }),
      entry({ tabId: 1, message: 'from github' }),
    ]);
    // The latest one — the label should say where the tab IS, not where it was.
    expect(groups[0].label).toBe('https://github.com');
    // And nothing was thrown away on navigate; both pages' output is still here.
    expect(groups[0].entries).toHaveLength(4);
  });

  it('never loses an entry that has no tab id', () => {
    const groups = groupByTab([entry({ message: 'orphan' }), entry({ tabId: 1 })]);
    const orphans = groups.find((g) => g.tabId === null)!;
    expect(orphans.label).toBe('Unattributed');
    expect(orphans.entries).toHaveLength(1);
  });

  it('falls back to the tab number when a tab never reported a navigation', () => {
    // Capture can begin after the tab loaded, so there may be no marker to read.
    const groups = groupByTab([entry({ tabId: 7 })]);
    expect(groups[0].label).toBe('Tab 7');
  });
});
