import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { activityStreamItemsAtom } from "@/atoms/sourceAtoms";
import { TOKEN_COUNT_QUERY_KEY } from "./useCountTokens";

/**
 * Derive token-circle visuals from chat:activity items (summarization +
 * context-compression), without new IPC. Scoped to the given chat when
 * item.chatId is set.
 *
 * PASS8 G2: also invalidates `TOKEN_COUNT_QUERY_KEY` whenever a compaction-
 * style activity transitions running → done, so the token bar re-fetches from
 * the source of truth (token_count_handlers, now parity-aware with
 * chat_context_summaries — see PASS8 G1) and the "100% / warning never leaves"
 * stale state clears immediately after compaction completes.
 */
const COMPACTION_LABEL_FILTER = /summariz|compress|compact/i;

export function useCompactionTokenVisuals(chatId: number | null): {
  pulse: boolean;
  flashSuccess: boolean;
} {
  const items = useAtomValue(activityStreamItemsAtom);
  const queryClient = useQueryClient();
  const [pulse, setPulse] = useState(false);
  const [flashSuccess, setFlashSuccess] = useState(false);
  const prevRunningRef = useRef(false);
  const lastSeenDoneIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (chatId == null) {
      setPulse(false);
      prevRunningRef.current = false;
      return;
    }

    const compactionItems = items.filter(
      (i) =>
        i.type === "background" &&
        COMPACTION_LABEL_FILTER.test(i.label) &&
        (i.chatId === chatId || i.chatId == null),
    );
    const last = compactionItems[compactionItems.length - 1];
    const running = last?.status === "running";
    setPulse(running);

    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = running;

    if (
      last &&
      last.status === "done" &&
      last.id !== lastSeenDoneIdRef.current
    ) {
      lastSeenDoneIdRef.current = last.id;
      // PASS8 G2: re-fetch the token bar after any compaction-style activity completes.
      queryClient.invalidateQueries({ queryKey: TOKEN_COUNT_QUERY_KEY });
    }

    if (wasRunning && !running && last && last.status === "done") {
      setFlashSuccess(true);
      const t = window.setTimeout(() => setFlashSuccess(false), 700);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [items, chatId, queryClient]);

  return { pulse, flashSuccess };
}
