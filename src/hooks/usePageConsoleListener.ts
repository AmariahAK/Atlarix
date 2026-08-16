/**
 * usePageConsoleListener
 * ======================
 * Feeds the Console tab's page-console stream from the in-app browser tabs.
 *
 * Subscribes to `browser:console` — the COALESCED, every-level channel — and
 * deliberately NOT to `browser:error`, which carries the same error-level
 * entries per-entry for its own older consumers. Listening to both would render
 * every error twice.
 */

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import {
  consoleUnreadCountAtom,
  networkUnreadCountAtom,
  pageConsoleAtom,
  type PageConsoleEntry,
} from '@/atoms/sourceAtoms';
import { IpcClient } from '@/ipc/ipc_client';

/**
 * What counts as worth a badge.
 *
 * Deliberately NOT every entry: a page logging `info` in a loop would sit on a
 * permanent unread count and the badge would stop meaning anything. Navigation
 * markers are dividers, not events. This is the DEFAULT — see the Console tab's
 * filter chips for reading everything.
 */
function isNoteworthy(entry: PageConsoleEntry): boolean {
  if (entry.type === 'navigated') return false;
  if (entry.type !== 'console-error') return true;
  return entry.level === 'error' || entry.level === 'warning';
}

/**
 * Renderer-side cap. The main process already bounds its own buffer; this bounds
 * what React holds and re-renders, which is the half that costs frames when a
 * page logs in a loop.
 */
const MAX_RENDERED_ENTRIES = 1000;

export function usePageConsoleListener() {
  const setEntries = useSetAtom(pageConsoleAtom);
  const setConsoleUnread = useSetAtom(consoleUnreadCountAtom);
  const setNetworkUnread = useSetAtom(networkUnreadCountAtom);

  useEffect(() => {
    // One parameter. The preload strips the Electron event, so `(_e, payload)`
    // silently never fires — a mistake this codebase has shipped 11 times.
    const off = IpcClient.getInstance().onBrowserConsoleBatch((batch) => {
      if (!Array.isArray(batch) || batch.length === 0) return;
      // Failed requests ride this channel too, which is what lets the Network
      // badge work without a second always-on subscription — the Network tab
      // itself only polls while it is on screen.
      const entries = batch as PageConsoleEntry[];
      const netFailures = entries.filter((e) => e.type === 'network-failed').length;
      const consoleNoteworthy = entries.filter(
        (e) => e.type !== 'network-failed' && isNoteworthy(e),
      ).length;
      if (netFailures > 0) setNetworkUnread((n) => n + netFailures);
      if (consoleNoteworthy > 0) setConsoleUnread((n) => n + consoleNoteworthy);
      setEntries((prev) => {
        const next = prev.concat(entries);
        return next.length > MAX_RENDERED_ENTRIES
          ? next.slice(-MAX_RENDERED_ENTRIES)
          : next;
      });
    });
    return () => off();
  }, [setEntries, setConsoleUnread, setNetworkUnread]);
}
