import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isStreamingForChatAtom, messagesForChatAtom } from "@/atoms/chatAtoms";
import { useSettings } from "@/hooks/useSettings";
import { IpcClient } from "@/ipc/ipc_client";
import { recapDecision, type RecapClock } from "@/lib/recap/rules";

/** The conversation as plain text for the recap: who said what, newest kept. */
function conversationText(messages: ReadonlyArray<{ role: string; content?: string | null }>): string {
  return messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => `${m.role === "user" ? "User" : "Atlarix"}: ${m.content}`)
    .join("\n\n")
    .slice(-60_000);
}

/**
 * The session recap (lib/recap): when you come back to this chat after a few
 * minutes away from the window, one line on where it stands. Written while
 * you're away, on the chat's own model; shown, never saved, never sent to the
 * model. Off in Settings → Notifications.
 */
export function SessionRecap({ chatId }: { chatId: number }) {
  const { t } = useTranslation("chat");
  const { settings } = useSettings();
  const enabled = settings?.sessionRecap !== false;
  const streaming = useAtomValue(isStreamingForChatAtom(chatId));
  const messages = useAtomValue(messagesForChatAtom(chatId));
  const [shown, setShown] = useState<string | null>(null);

  const clock = useRef<RecapClock>({ completedTurns: 0, lastTurnEndedAt: null, recappedAfterTurn: -1 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = useRef<string | null>(null);
  const present = useRef(typeof document === "undefined" || document.hasFocus());
  const live = useRef({ enabled, streaming, messages });
  live.current = { enabled, streaming, messages };

  // A new chat starts its own count from the turns it already has.
  useEffect(() => {
    clock.current = {
      completedTurns: messages.filter((m) => m.role === "assistant").length,
      lastTurnEndedAt: null,
      recappedAfterTurn: -1,
    };
    setShown(null);
    ready.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const d = recapDecision({
      ...clock.current,
      enabled: live.current.enabled,
      present: present.current,
      busy: live.current.streaming,
      now: Date.now(),
    });
    if (d.kind === "wait") timer.current = setTimeout(arm, d.ms);
    else if (d.kind === "now") void write();
  };

  const write = async () => {
    clock.current.recappedAfterTurn = clock.current.completedTurns;
    const r = await IpcClient.getInstance()
      .generateRecap(chatId, conversationText(live.current.messages))
      .catch(() => ({ text: null }));
    if (!r.text) return;
    if (present.current) setShown(r.text);
    else ready.current = r.text;
  };

  // A turn ending is the clock's tick.
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      clock.current.completedTurns++;
      clock.current.lastTurnEndedAt = Date.now();
      ready.current = null;
      if (!present.current) arm();
    }
    if (streaming) setShown(null);
    wasStreaming.current = streaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  // Away = the window is not in front.
  useEffect(() => {
    const back = () => {
      if (!document.hasFocus() || document.visibilityState !== "visible") return;
      present.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (ready.current) {
        setShown(ready.current);
        ready.current = null;
      }
    };
    const away = () => {
      present.current = false;
      arm();
    };
    const onVisibility = () => (document.visibilityState === "visible" ? back() : away());
    window.addEventListener("focus", back);
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", back);
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  if (!shown) return null;
  return (
    <div className="flex justify-start" role="status">
      <div className="mr-12 flex max-w-3xl items-start gap-2 rounded-md border-l-2 border-primary bg-muted/40 px-3 py-2 text-sm">
        <span className="text-primary" aria-hidden>
          ◷
        </span>
        <span className="text-muted-foreground">
          <span className="text-foreground">{t("recap.label", "While you were away")}</span>
          {" · "}
          {shown}
        </span>
        <button
          type="button"
          className="ml-1 text-muted-foreground hover:text-foreground"
          aria-label={t("recap.dismiss", "Dismiss")}
          onClick={() => setShown(null)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
