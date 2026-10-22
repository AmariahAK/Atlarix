import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isStreamingForChatAtom, messagesForChatAtom } from "@/atoms/chatAtoms";
import { activeSessionWorkModeAtom } from "@/atoms/sessionAtoms";
import { useSettings } from "@/hooks/useSettings";
import { IpcClient, type FeedbackSessionInfo } from "@/ipc/ipc_client";
import {
  FEEDBACK_FAILED,
  FEEDBACK_MAX,
  FEEDBACK_QUESTION,
  FEEDBACK_THANKS,
  FEEDBACK_TOO_LONG,
  FEEDBACK_USAGE,
  RATING_QUESTION,
  RATING_SENDS,
  shouldAskRating,
} from "@/lib/feedback/session-rating";

/**
 * "How is Atlarix doing this session?" above the composer, then "What should
 * we improve?" (lib/feedback/session-rating.ts: after a few turns, once a
 * session, days apart across the app, the CLI and the editors). Keys 1-3 answer
 * and 0 dismisses while the composer is empty. `/feedback` opens the second
 * half directly (`openFeedbackFor`).
 */
type Given = { rating?: 1 | 2 | 3; body?: string; problem?: "rating" | "too_long" };
let openFeedback: ((chatId: number, given: Given) => void) | null = null;

/** `/feedback [1|2|3] [text]` typed in the composer: sent, or the text box when there is nothing after it. */
export function openFeedbackFor(chatId: number, given: Given = {}): void {
  openFeedback?.(chatId, given);
}

export function SessionRatingCard({ chatId, composerEmpty }: { chatId: number; composerEmpty: boolean }) {
  const { t } = useTranslation("chat");
  const { settings } = useSettings();
  const mode = useAtomValue(activeSessionWorkModeAtom);
  const streaming = useAtomValue(isStreamingForChatAtom(chatId));
  const messages = useAtomValue(messagesForChatAtom(chatId));
  const [stage, setStage] = useState<"none" | "ask" | "improve" | "thanks">("none");
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const asked = useRef(false);
  const startedAt = useRef(Date.now());
  const wasStreaming = useRef(streaming);

  // A chat of its own: its own "once a session".
  useEffect(() => {
    asked.current = false;
    startedAt.current = Date.now();
    setStage("none");
  }, [chatId]);

  useEffect(() => {
    openFeedback = (id, given) => {
      if (id !== chatId) return;
      setNote(null);
      // "/feedback 7", or text over the limit: nothing is sent, and the words stay to fix (QA E3).
      if (given.problem) {
        if (given.body) setText(given.body);
        setNote(given.problem === "rating" ? FEEDBACK_USAGE : FEEDBACK_TOO_LONG);
        return setStage("improve");
      }
      if (given.rating) rate(given.rating, false);
      if (given.body) return void send(given.body);
      setStage(given.rating ? "thanks" : "improve");
      if (given.rating) setTimeout(() => setStage((st) => (st === "thanks" ? "none" : st)), 3000);
    };
    return () => {
      openFeedback = null;
    };
  });

  const turns = messages.filter((m) => m.role === "user").length;
  const session = (): FeedbackSessionInfo => ({
    mode: mode ?? undefined,
    effort: settings?.effort || undefined,
    provider: settings?.selectedModel?.provider,
    model: settings?.selectedModel?.name,
    turns,
    startedAt: startedAt.current,
  });

  // A turn just ended: is the question due?
  useEffect(() => {
    const ended = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;
    if (!ended || asked.current || stage !== "none") return;
    let alive = true;
    void IpcClient.getInstance()
      .getFeedbackState()
      .then((s) => {
        if (!alive) return;
        const due = shouldAskRating({
          turns,
          ratedAt: s.askedAt ?? undefined,
          now: Date.now(),
          askedThisSession: asked.current,
          force: s.force,
        });
        if (due) setStage("ask");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  const rate = (rating: number, thenImprove = true) => {
    asked.current = true;
    void IpcClient.getInstance().rateSession(rating, session()).catch(() => {});
    setNote(null);
    if (thenImprove) setStage(rating === 0 ? "none" : "improve");
  };

  // 1-3 answer and 0 dismisses, while the composer is empty.
  useEffect(() => {
    if (stage !== "ask" || !composerEmpty) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !["0", "1", "2", "3"].includes(e.key)) return;
      e.preventDefault();
      rate(Number(e.key));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, composerEmpty]);

  const send = async (given?: string) => {
    const words = (given ?? text).trim();
    if (!words) return setStage("none");
    if (given) setText(given);
    setStage("improve");
    if (words.length > FEEDBACK_MAX) return setNote(FEEDBACK_TOO_LONG);
    setSending(true);
    const r = await IpcClient.getInstance()
      .sendFeedback(words, session())
      .catch(() => ({ ok: false }));
    setSending(false);
    // What you typed stays in the box until it is sent.
    if (!r.ok) return setNote(FEEDBACK_FAILED);
    setText("");
    setStage("thanks");
    setTimeout(() => setStage((s) => (s === "thanks" ? "none" : s)), 3000);
  };

  if (stage === "none") return null;
  return (
    <div className="mb-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      {stage === "thanks" ? (
        <p className="text-xs text-muted-foreground">{FEEDBACK_THANKS}</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{stage === "ask" ? RATING_QUESTION : FEEDBACK_QUESTION}</span>
            <button
              type="button"
              aria-label={t("sessionRating.dismiss")}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => (stage === "ask" ? rate(0) : setStage("none"))}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {stage === "ask" ? (
            <>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => rate(1)}>
                  {t("sessionRating.bad")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => rate(2)}>
                  {t("sessionRating.fine")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => rate(3)}>
                  {t("sessionRating.good")}
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{RATING_SENDS}</p>
            </>
          ) : (
            <>
              <textarea
                className="mt-2 w-full resize-none rounded-md border border-border bg-background p-2 text-sm"
                rows={3}
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
              />
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" disabled={sending} onClick={() => void send()}>
                  {t("sessionRating.send")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setStage("none")}>
                  {t("sessionRating.skip")}
                </Button>
                {note ? <span className="text-xs text-destructive">{note}</span> : null}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
