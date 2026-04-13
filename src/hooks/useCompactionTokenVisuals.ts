import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { activityStreamItemsAtom } from "@/atoms/sourceAtoms";

/**
 * Derive token-circle visuals from chat:activity background items (summarization),
 * without new IPC. Scoped to the given chat when item.chatId is set.
 */
export function useCompactionTokenVisuals(chatId: number | null): {
  pulse: boolean;
  flashSuccess: boolean;
} {
  const items = useAtomValue(activityStreamItemsAtom);
  const [pulse, setPulse] = useState(false);
  const [flashSuccess, setFlashSuccess] = useState(false);
  const prevRunningRef = useRef(false);

  useEffect(() => {
    if (chatId == null) {
      setPulse(false);
      prevRunningRef.current = false;
      return;
    }

    const summarizationItems = items.filter(
      (i) =>
        i.type === "background" &&
        /summariz/i.test(i.label) &&
        (i.chatId === chatId || i.chatId == null),
    );
    const last = summarizationItems[summarizationItems.length - 1];
    const running = last?.status === "running";
    setPulse(running);

    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = running;

    if (wasRunning && !running && last && last.status === "done") {
      setFlashSuccess(true);
      const t = window.setTimeout(() => setFlashSuccess(false), 700);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [items, chatId]);

  return { pulse, flashSuccess };
}
