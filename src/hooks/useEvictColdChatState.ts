/**
 * Free the renderer state of a chat once it goes cold.
 *
 * The view has always been windowed — react-virtuoso by default, a 120-message
 * render cap on the fallback path — but the data behind it was not. The per-chat
 * maps in `chatAtoms` are keyed by chat and message id and grew monotonically:
 * the pruner existed (`clearChatAtomsForChat`, written for this leak in v12) but
 * only two callers ever fired it, on session DELETE and on NEW conversation.
 * Switching away, which is the normal case, freed nothing. Open four large
 * sessions while working and all four were held in full while one was on screen.
 * Sub-agent transcripts are the worst of it — up to five concurrent workers
 * streaming thinking, narration and tool activity into the same never-pruned
 * maps, which is the highest ratio of bytes-held to value-after-the-fact in the
 * renderer.
 *
 * **Cold means: not the visually-active chat, and not streaming.** Being open in
 * a tab does NOT protect a chat — with two sessions open and the second on
 * screen, the first is cold, which is the whole point. A streaming chat is never
 * touched: its turn is still writing into those maps, and main's transport (which
 * the model reads) is untouched either way, so background streams keep running
 * exactly as documented.
 *
 * This does NOT make a large session open faster. That cost is the synchronous
 * `parseDisplaySnapshot` per row in `workspace_session_handlers`, and freeing
 * memory afterwards cannot make the first parse cheaper.
 */

import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { activeChatIdAtom, isStreamingByIdAtom } from "@/atoms/chatAtoms";
import { clearChatAtomsForChat } from "@/lib/chat/clear-chat-atoms";

export function useEvictColdChatState(): void {
  const activeChatId = useAtomValue(activeChatIdAtom);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  /**
   * Which chat we last saw as active. A ref, not state — this must not itself
   * cause a render, and it is only ever read inside the effect.
   */
  const previousActiveRef = useRef<number | null>(null);

  useEffect(() => {
    const previous = previousActiveRef.current;
    previousActiveRef.current = activeChatId;

    // On mount `previous` is null: there is nothing to evict, and acting here
    // would be a state change caused by an effect firing on window open with no
    // user action — the exact shape of the v14.34.0 bug, where an effect on open
    // silently reconfigured a session. Only a real transition evicts.
    if (previous == null || previous === activeChatId) return;

    // Streaming wins over cold. The turn is still writing into these maps, and a
    // parked turn can resume into them.
    if (isStreamingById.get(previous) === true) return;

    clearChatAtomsForChat(previous, { reason: "evicted" });
  }, [activeChatId, isStreamingById]);
}
