/**
 * useBrowserNetwork
 * =================
 * Feeds the Network tab by POLLING the main process while the tab is mounted.
 *
 * Pull rather than push, deliberately. A page load is hundreds of requests; a
 * per-request IPC channel is the same flood shape that once cost this app a
 * thermal regression, and nobody needs 400 individual updates to read a list.
 * Capture in the main process runs whether or not this hook is alive, so
 * mounting late loses nothing — which is also why the panel being closed costs
 * no data.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IpcClient } from '@/ipc/ipc_client';
import type { BrowserNetworkSnapshot } from '@/lib/browser/network-entry';

/** Fast enough to feel live while reading, slow enough to cost nothing. */
const POLL_MS = 1000;

const EMPTY: BrowserNetworkSnapshot = { tabs: [] };

export function useBrowserNetwork(active: boolean) {
  const [snapshot, setSnapshot] = useState<BrowserNetworkSnapshot>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  // A slow reply must not stack another request on top of it, and a reply that
  // lands after unmount must not set state.
  const inFlight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await IpcClient.getInstance().browserGetNetwork();
      if (alive.current) {
        setSnapshot(next ?? EMPTY);
        setLoaded(true);
      }
    } catch {
      // A failed poll is not worth surfacing — the next one is a second away.
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!active) return () => { alive.current = false; };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [active, refresh]);

  return { snapshot, loaded, refresh };
}
