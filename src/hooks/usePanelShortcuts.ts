/**
 * Global keyboard shortcuts for panels and work modes (cross-platform: Cmd on
 * mac, Ctrl elsewhere).
 * - Cmd/Ctrl+B: toggle right panel.
 * - Shift+Tab: cycle work mode Explore → Plan → Build → Debug → Review (workspace chats).
 * - Cmd/Ctrl+J: open the model picker (right-side sheet).
 * - Cmd/Ctrl+T: new browser tab (opens the browser panel).
 * - Cmd/Ctrl+I ← / Cmd/Ctrl+O → : move between right-panel tabs.
 * (Cmd/Ctrl+W closes the active browser tab — handled in main via before-input-event.)
 * Panels open at 30% window width; close does not change stored width.
 */

import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  rightPanelVisibleAtom,
  rightPanelWidthAtom,
  rightPanelSuppressAutoOpenAtom,
  previewTabAtom,
  modelSheetOpenAtom,
  rightPanelOrderedTabsAtom,
} from "@/atoms/sourceAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { showInfo } from "@/lib/toast";
import type { PanelTab } from "@/atoms/sourceAtoms";
import { useSettings } from "@/hooks/useSettings";
import { labelForWorkMode } from "@/lib/work-mode";
import { useWorkModeSelection } from "@/hooks/useWorkModeSelection";
import type { WorkMode } from "@/lib/schemas";

const WORK_MODE_CYCLE: WorkMode[] = ["ask", "plan", "build", "debug", "review"];

/**
 * THERE WAS AN `isInputLike` GUARD HERE, and it was unreachable.
 *
 * It sat at the very END of the keydown handler, after every chord branch — and each of
 * those branches returns, so control never arrived. It read as "these shortcuts do not
 * fire while you are typing", which is the opposite of the truth: every chord below is
 * deliberately live in a focused composer (see the note on the work-mode cycle), and
 * that is the behaviour users have. Removed rather than moved, because moving it to the
 * top would be a real behaviour change and not the one it looked like it was making.
 */
export function usePanelShortcuts() {
  const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setModelSheetOpen = useSetAtom(modelSheetOpenAtom);
  const orderedTabs = useAtomValue(rightPanelOrderedTabsAtom);

  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { settings, updateSettings } = useSettings();
  const { workMode, setWorkMode } = useWorkModeSelection();

  useEffect(() => {
    const openRightPanel = () => {
      setSuppressRightAutoOpen(false);
      const w = Math.max(280, Math.min(700, Math.floor(window.innerWidth * 0.3)));
      setRightPanelWidth(w);
      setRightPanelVisible(true);
    };
    const toggleRightPanel = () => {
      if (rightPanelVisible) {
        setSuppressRightAutoOpen(true);
        setRightPanelVisible(false);
      } else {
        openRightPanel();
      }
    };
    // Move the active right-panel tab by `dir` over the visible, ordered tabs.
    const movePanelTab = (dir: -1 | 1) => {
      const { tabs, active } = orderedTabs;
      if (tabs.length < 2) return;
      const idx = tabs.indexOf(active as PanelTab);
      if (idx < 0) return;
      const next = tabs[Math.max(0, Math.min(tabs.length - 1, idx + dir))];
      if (next && next !== active) {
        if (!rightPanelVisible) openRightPanel();
        setPreviewTab(next);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = typeof navigator !== "undefined" && navigator.platform?.toLowerCase().startsWith("mac") ? e.metaKey : e.ctrlKey;

      // Cmd/Ctrl+B: toggle right panel (ungated). Works even when an input is
      // focused — like editors — since the chord can't insert text anyway.
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleRightPanel();
        return;
      }

      // Shift+Tab: cycle work mode (Explore → Plan → Build → Debug → Review).
      // Kept ABOVE the isInputLike guard (like Cmd/Ctrl+B) so it stays global +
      // always-live — the composer keeps focus while typing and during an
      // in-flight stream, and the old placement below the guard silently dropped
      // the chord in exactly those "busy" moments. We only intercept shiftKey+Tab,
      // so plain Tab (indent) in the composer is untouched.
      if (e.shiftKey && !mod && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        if (selectedAppId == null) {
          showInfo("Work modes are available in workspace chats.");
          return;
        }
        // Cycle from — and write to — the SAME place the picker uses.
        //
        // This read the global preference alone and wrote only the global, while the
        // picker reads `session ?? global` and writes both. In any session with a
        // stored mode that made the chord a no-op with a toast: the cycle started
        // from the wrong mode, and because a turn dispatches with
        // `workModeOverride ?? sessionWorkMode`, the mode the next turn actually ran
        // in never changed. The visible chip not moving was the honest symptom.
        const idx = WORK_MODE_CYCLE.indexOf(workMode);
        const next = WORK_MODE_CYCLE[(idx + 1) % WORK_MODE_CYCLE.length];
        setWorkMode(next);
        showInfo(`Mode: ${labelForWorkMode(next)}`);
        return;
      }

      // Cmd/Ctrl+J: toggle the model picker (right-side sheet). Above the guard
      // so it works while composing.
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setModelSheetOpen((v) => !v);
        return;
      }

      // Cmd/Ctrl+T: new browser tab (browser panel is already multi-tab). Open
      // the panel on the browser tab, then create the tab; BrowserPanel refreshes
      // via onBrowserStateChanged.
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        if (!rightPanelVisible) openRightPanel();
        setPreviewTab("browser");
        void IpcClient.getInstance().browserCreateTab();
        return;
      }

      // Cmd/Ctrl+I ← / Cmd/Ctrl+O → : move between right-panel tabs.
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        movePanelTab(-1);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        movePanelTab(1);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    rightPanelVisible,
    setRightPanelVisible,
    setRightPanelWidth,
    setSuppressRightAutoOpen,
    setPreviewTab,
    setModelSheetOpen,
    orderedTabs,
    selectedAppId,
    // The chord reads `workMode` when it fires, so the listener must be rebound when
    // it changes — otherwise the cycle steps from whatever the mode was when the
    // effect last ran and appears to stick.
    workMode,
    setWorkMode,
    settings?.workModePreference,
    settings?.selectedChatMode,
    updateSettings,
  ]);
}
