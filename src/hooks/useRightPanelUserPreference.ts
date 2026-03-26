import { useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  rightPanelVisibleAtom,
  rightPanelSuppressAutoOpenAtom,
} from "@/atoms/sourceAtoms";

/**
 * When the user explicitly hides the right panel, we suppress auto-opening it on
 * subsequent stream events (sources, diagrams, terminal) until they open it again.
 * Permission requests still force the panel open so approvals are not missed.
 */
export function useRightPanelUserPreference() {
  const [visible, setVisible] = useAtom(rightPanelVisibleAtom);
  const setSuppressAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);

  const toggle = useCallback(() => {
    setVisible((v) => {
      const next = !v;
      setSuppressAutoOpen(!next);
      return next;
    });
  }, [setVisible, setSuppressAutoOpen]);

  /** User explicitly opened the panel (toggle, shortcut, or "sources" badge). */
  const show = useCallback(() => {
    setSuppressAutoOpen(false);
    setVisible(true);
  }, [setSuppressAutoOpen, setVisible]);

  return { visible, toggle, show };
}
