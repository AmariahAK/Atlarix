/**
 * Open a URL in the in-app Browser panel as a new tab and surface it.
 *
 * The single entry point for "a clicked http(s) URL should open in Atlarix's
 * browser" — used by chat message links (AtlarixMarkdownParser) and terminal
 * links (XtermView). Each call stacks a NEW browser tab (so the user can open
 * several and pick), makes the browser surface visible, switches the right panel
 * to the Browser tab, and opens the panel. External-browser opening (Cmd/Ctrl+
 * click) is handled by the callers, not here.
 */
import { getDefaultStore } from "jotai";
import { previewTabAtom, rightPanelVisibleAtom } from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";

/** True for http(s) URLs we can open in the in-app browser. */
export function isOpenableInBrowserTab(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Open `url` as a new browser tab and reveal the Browser panel. */
export function openUrlInBrowserTab(url: string): void {
  if (!isOpenableInBrowserTab(url)) return;
  const store = getDefaultStore();
  store.set(previewTabAtom, "browser");
  store.set(rightPanelVisibleAtom, true);
  void IpcClient.getInstance().browserCreateTab(url);
  void IpcClient.getInstance().browserSetVisible(true);
}
