/**
 * Pro-only keyboard shortcuts for toggling left and right panels.
 * Cmd+I / Ctrl+I: left panel. Cmd+O / Ctrl+O: right panel.
 * Open at 30% window width; close does not change stored width.
 * When not Pro, shortcuts show upgrade toast.
 */

import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  leftPanelVisibleAtom,
  leftPanelWidthAtom,
  rightPanelVisibleAtom,
  rightPanelWidthAtom,
} from "@/atoms/sourceAtoms";
import { useAuth } from "@/lib/auth/useAuth";
import { triggerUpgrade } from "@/hooks/useUpgrade";
import { showInfo } from "@/lib/toast";

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

  const leftPanelVisible = useAtomValue(leftPanelVisibleAtom);
  const setLeftPanelVisible = useSetAtom(leftPanelVisibleAtom);
  const setLeftPanelWidth = useSetAtom(leftPanelWidthAtom);

  const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isInputLike(e.target)) return;

      const mod = typeof navigator !== "undefined" && navigator.platform?.toLowerCase().startsWith("mac") ? e.metaKey : e.ctrlKey;

      if (mod && e.key === "i") {
        e.preventDefault();
        if (!isPro) {
          showInfo("Panel shortcuts are available on Pro. Upgrade to use Cmd+I / Cmd+O.");
          triggerUpgrade();
          return;
        }
        if (leftPanelVisible) {
          setLeftPanelVisible(false);
        } else {
          const w = Math.max(200, Math.floor(window.innerWidth * 0.3));
          setLeftPanelWidth(w);
          setLeftPanelVisible(true);
        }
        return;
      }

      if (mod && e.key === "o") {
        e.preventDefault();
        if (!isPro) {
          showInfo("Panel shortcuts are available on Pro. Upgrade to use Cmd+I / Cmd+O.");
          triggerUpgrade();
          return;
        }
        if (rightPanelVisible) {
          setRightPanelVisible(false);
        } else {
          const w = Math.max(280, Math.min(700, Math.floor(window.innerWidth * 0.3)));
          setRightPanelWidth(w);
          setRightPanelVisible(true);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isPro,
    leftPanelVisible,
    setLeftPanelVisible,
    setLeftPanelWidth,
    rightPanelVisible,
    setRightPanelVisible,
    setRightPanelWidth,
  ]);
}
