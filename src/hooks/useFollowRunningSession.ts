/**
 * Follow a turn of this chat's session that another Atlarix runs (the CLI, an
 * editor): a session is live where its turn runs (lib/peers).
 *
 * While the window is visible and this chat is not streaming here, it asks
 * every 1.5 s (drafts are saved that often) whether the session is running
 * elsewhere. If so it re-reads the session whenever it has changed, so the turn
 * grows on screen here; the composer then steers and stops that turn
 * (SimpleChatInput). When the turn ends, one last read, which also rebuilds
 * the transport from the database: the next message runs here, with the whole
 * conversation.
 */
import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { followingByChatIdAtom, isStreamingByIdAtom } from "@/atoms/chatAtoms";
import { chatIdToSessionIdAtom } from "@/atoms/sessionAtoms";
import { hydrateSessionIntoChat } from "@/lib/chat/hydrate-session-into-chat";

const FOLLOW_POLL_MS = 1_500;

export function useFollowRunningSession(chatId: number): void {
  const sessionId = useAtomValue(chatIdToSessionIdAtom).get(chatId);
  const streamingHere = useAtomValue(isStreamingByIdAtom).get(chatId) === true;
  const setFollowing = useSetAtom(followingByChatIdAtom);

  useEffect(() => {
    if (!sessionId || streamingHere) return;
    const ipc = IpcClient.getInstance();
    const mark = (where: { surface: "cli" | "app" | "chrome" | "editor"; name: string } | null) =>
      setFollowing((prev) => {
        if (!where && !prev.has(chatId)) return prev;
        const next = new Map(prev);
        if (where) next.set(chatId, where);
        else next.delete(chatId);
        return next;
      });
    let alive = true;
    let asking = false;
    let following = false;
    let revision = "";
    const tick = async () => {
      if (asking || document.visibilityState !== "visible") return;
      asking = true;
      try {
        const where = await ipc.sessionRunningElsewhere(sessionId);
        if (!alive) return;
        if (where) {
          following = true;
          mark(where);
          const now = await ipc.sessionRevision(sessionId);
          if (alive && now !== revision) {
            revision = now;
            await hydrateSessionIntoChat({ sessionId, chatId });
          }
        } else if (following) {
          following = false;
          revision = "";
          mark(null);
          await hydrateSessionIntoChat({ sessionId, chatId });
        }
      } catch {
        /* the next tick asks again */
      } finally {
        asking = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), FOLLOW_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      mark(null);
    };
  }, [chatId, sessionId, streamingHere, setFollowing]);
}
