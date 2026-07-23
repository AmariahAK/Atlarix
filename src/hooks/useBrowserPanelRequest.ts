/**
 * useBrowserPanelRequest
 * ======================
 * Opens the right panel on its Browser tab when the AGENT needs the browser on
 * screen, mirroring how a plan artifact surfaces the Plan tab
 * (`useWorkspacePlanPanel`).
 *
 * Why this exists: the browser page is a main-process `WebContentsView` that
 * renders natively over whatever rect the React panel reports. If main simply
 * made it visible while the panel was closed, the user got a bare browser slab
 * over half the window — no tab strip, no URL bar — because the chrome that
 * frames it was never mounted. So main asks, and the UI decides.
 *
 * Must be mounted somewhere ALWAYS present (DevServerProvider), not in
 * BrowserPanel itself — the whole point is to react while that panel is closed.
 */

import { useEffect } from "react";
import { getDefaultStore } from "jotai";
import {
  previewTabAtom,
  rightPanelVisibleAtom,
  rightPanelSuppressAutoOpenAtom,
} from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";

export function useBrowserPanelRequest() {
  useEffect(() => {
    const off = IpcClient.getInstance().onBrowserPanelRequested(() => {
      const store = getDefaultStore();
      store.set(previewTabAtom, "browser");
      // Honour the user's "don't auto-open" preference, exactly as the plan
      // panel does — selecting the tab is still correct so it's the one they
      // land on when they open the panel themselves.
      if (!store.get(rightPanelSuppressAutoOpenAtom)) {
        store.set(rightPanelVisibleAtom, true);
      }
    });
    return off;
  }, []);
}
