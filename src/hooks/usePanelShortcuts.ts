/**
 * Global keyboard shortcuts for panels and work modes.
 * - Cmd+B / Ctrl+B: toggle right panel (everyone).
 * - Shift+Tab: cycle work mode Explore → Plan → Build → Debug → Review (workspace chats).
 * - Cmd+O / Ctrl+O: right panel (Pro; shows upgrade toast otherwise).
 * Panels open at 30% window width; close does not change stored width.
 */

import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  rightPanelVisibleAtom,
  rightPanelWidthAtom,
  rightPanelSuppressAutoOpenAtom,
} from "@/atoms/sourceAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useAuth } from "@/lib/auth/useAuth";
import { triggerUpgrade } from "@/hooks/useUpgrade";
import { showInfo } from "@/lib/toast";
import { useSettings } from "@/hooks/useSettings";
import { labelForWorkMode, settingsPatchForWorkMode } from "@/lib/work-mode";
import type { WorkMode } from "@/lib/schemas";

const WORK_MODE_CYCLE: WorkMode[] = ["ask", "plan", "build", "debug", "review"];

const isInputLike = (el: EventTarget | null): boolean => {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  if (el.isContentEditable) return true;
  return false;
};

export function usePanelShortcuts() {
  const { status } = useAuth();
  const isPro = status?.plan === "pro";

  const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);

  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { settings, updateSettings } = useSettings();

  useEffect(() => {
    const toggleRightPanel = () => {
      if (rightPanelVisible) {
        setSuppressRightAutoOpen(true);
        setRightPanelVisible(false);
      } else {
        setSuppressRightAutoOpen(false);
        const w = Math.max(280, Math.min(700, Math.floor(window.innerWidth * 0.3)));
        setRightPanelWidth(w);
        setRightPanelVisible(true);
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
        const current: WorkMode =
          settings?.workModePreference ??
          (settings?.selectedChatMode === "ask" ? "ask" : "build");
        const idx = WORK_MODE_CYCLE.indexOf(current);
        const next = WORK_MODE_CYCLE[(idx + 1) % WORK_MODE_CYCLE.length];
        void updateSettings(settingsPatchForWorkMode(next));
        showInfo(`Mode: ${labelForWorkMode(next)}`);
        return;
      }

      if (isInputLike(e.target)) return;

      if (mod && e.key === "o") {
        e.preventDefault();
        if (!isPro) {
          showInfo("Panel shortcuts are available on Pro. Upgrade to use Cmd+O.");
          triggerUpgrade();
          return;
        }
        toggleRightPanel();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isPro,
    rightPanelVisible,
    setRightPanelVisible,
    setRightPanelWidth,
    setSuppressRightAutoOpen,
    selectedAppId,
    settings?.workModePreference,
    settings?.selectedChatMode,
    updateSettings,
  ]);
}
