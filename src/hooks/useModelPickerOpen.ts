/**
 * Which model picker Cmd/Ctrl+J is talking to.
 *
 * THE PROBLEM THIS EXISTS FOR. `ChatInputControls` can be mounted TWICE at the
 * same time. `PersistentChatContainer` (`app/layout.tsx:516`) hides itself with
 * a CSS class rather than unmounting, and the right panel's Chat tab
 * (`RightPanel.tsx:469` → `EmbeddedChatTab` → `SimpleInlineChat` →
 * `SimpleChatInput` → `ChatInputControls`) mounts a second composer whenever
 * the panel is dragged to within 80px of the window width
 * (`useRightPanelContext.ts:112`). That state is one splitter-drag away.
 *
 * `modelSheetOpenAtom` is a single global boolean, so binding a picker's `open`
 * straight to it would open BOTH pickers at once: two portalled popovers, two
 * search boxes, two divergent query strings, and whichever mounted last
 * stealing the caret. The old right-edge `Sheet` had the same flaw and got away
 * with it only because two identical overlays stack invisibly.
 *
 * SO: OPEN STATE IS LOCAL, and only the owning composer mirrors the global
 * atom. Clicking either chip opens that chip; the chord reaches exactly one.
 *
 * OWNERSHIP IS A STACK, NOT A FLAG. Each composer registers on mount and
 * deregisters on unmount; the last registrant owns the chord. Mount order does
 * the right thing by itself — the embedded tab only exists while the main chat
 * area is hidden, so it takes ownership when it appears and hands it BACK when
 * the panel narrows and it unmounts. A single `ownerAtom` written on mount
 * could not do that second half.
 *
 * `modelSheetOpenAtom` keeps its shape and its meaning, so `usePanelShortcuts`
 * and the `shortcuts-table` conformance test are untouched.
 */

import { useAtom } from "jotai";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { modelPickerMountsAtom, modelSheetOpenAtom } from "@/atoms/sourceAtoms";

export interface ModelPickerOpenState {
  open: boolean;
  setOpen: (next: boolean) => void;
  /** True when this composer is the one Cmd/Ctrl+J would reach. */
  isOwner: boolean;
}

/**
 * @param resetKey Changing it closes the picker — pass the thread id, so
 *   switching chats never leaves a picker hanging open over the new one.
 */
export function useModelPickerOpen(
  resetKey?: number | null,
): ModelPickerOpenState {
  const id = useId();
  const [mounts, setMounts] = useAtom(modelPickerMountsAtom);
  const [chordOpen, setChordOpen] = useAtom(modelSheetOpenAtom);
  const [open, setLocalOpen] = useState(false);

  useEffect(() => {
    setMounts((prev) => [...prev, id]);
    return () => {
      setMounts((prev) => prev.filter((m) => m !== id));
      // Never leave the flag true behind a composer that no longer exists — it
      // would reopen, and steal focus, on the next one to mount.
      setChordOpen(false);
    };
  }, [id, setMounts, setChordOpen]);

  const isOwner = mounts.length === 0 || mounts[mounts.length - 1] === id;

  // The chord drives the owner only. `useRef` so this mirrors CHANGES to the
  // atom rather than re-asserting its value over a local click.
  const lastChordOpen = useRef(chordOpen);
  useEffect(() => {
    if (lastChordOpen.current !== chordOpen) {
      lastChordOpen.current = chordOpen;
      if (isOwner) setLocalOpen(chordOpen);
    }
  }, [chordOpen, isOwner]);

  useEffect(() => {
    setLocalOpen(false);
  }, [resetKey]);

  const setOpen = useCallback(
    (next: boolean) => {
      setLocalOpen(next);
      // Keep the chord's toggle in step, so ⌘J after a click-open closes it
      // rather than appearing to do nothing.
      if (isOwner) {
        lastChordOpen.current = next;
        setChordOpen(next);
      }
    },
    [isOwner, setChordOpen],
  );

  return { open, setOpen, isOwner };
}
