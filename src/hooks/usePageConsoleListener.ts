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
import { pageConsoleAtom, type PageConsoleEntry } from '@/atoms/sourceAtoms';
import { IpcClient } from '@/ipc/ipc_client';

/**
 * Renderer-side cap. The main process already bounds its own buffer; this bounds
 * what React holds and re-renders, which is the half that costs frames when a
 * page logs in a loop.
 */
const MAX_RENDERED_ENTRIES = 1000;

export function usePageConsoleListener() {
  const setEntries = useSetAtom(pageConsoleAtom);

  useEffect(() => {
    // One parameter. The preload strips the Electron event, so `(_e, payload)`
    // silently never fires — a mistake this codebase has shipped 11 times.
    const off = IpcClient.getInstance().onBrowserConsoleBatch((batch) => {
      if (!Array.isArray(batch) || batch.length === 0) return;
      setEntries((prev) => {
        const next = prev.concat(batch as PageConsoleEntry[]);
        return next.length > MAX_RENDERED_ENTRIES
          ? next.slice(-MAX_RENDERED_ENTRIES)
          : next;
      });
    });
    return () => off();
  }, [setEntries]);
}
