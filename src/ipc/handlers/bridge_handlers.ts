/**
 * Browser-bridge status for Settings → Browser.
 *
 * Since v14.52.0 the agent's only browser is the user's Chrome (or Edge /
 * Brave) through the Atlarix extension, so "is it connected, and which
 * version" is the one thing a user needs to see when browsing does not work.
 * Read-only: the browser opens the connection; the app cannot dial it.
 */

import { ipcMain } from "electron";
import { bridge } from "@/main/bridge-lifecycle";
import { CHROME_STORE_URL } from "@/lib/bridge/host-install";

export interface BridgeStatus {
  /** False when this build has no native relay at all. */
  available: boolean;
  connected: boolean;
  /** One per connected browser; the most recent one serves requests. */
  browsers: Array<{ browser?: string; extensionVersion?: string }>;
  storeUrl: string;
}

export function registerBridgeHandlers(): void {
  ipcMain.handle("bridge:status", (): BridgeStatus => {
    const server = bridge();
    return {
      available: server !== null,
      connected: server?.connected ?? false,
      browsers: (server?.peerInfo ?? []).map((p) => ({
        browser: p.browser,
        extensionVersion: p.extensionVersion,
      })),
      storeUrl: CHROME_STORE_URL,
    };
  });
}
