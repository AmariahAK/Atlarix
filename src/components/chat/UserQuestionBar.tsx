import { useCallback, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  pendingUserQuestionByChatIdAtom,
  askUserStreamFreezeBaselineByChatIdAtom,
  type PendingUserQuestion,
} from "@/atoms/chatAtoms";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { MessageCircleQuestion } from "lucide-react";

type Props = {
  chatId: number;
};

export function UserQuestionBar({ chatId }: Props) {
  const [pendingByChat, setPendingByChat] = useAtom(pendingUserQuestionByChatIdAtom);
  const setFreezeBaselineByChat = useSetAtom(askUserStreamFreezeBaselineByChatIdAtom);
  const pending: PendingUserQuestion | undefined = pendingByChat[chatId];
  const [customAnswer, setCustomAnswer] = useState("");

  const clearPending = useCallback(() => {
    setPendingByChat((prev) => {
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
    setCustomAnswer("");
  }, [chatId, setPendingByChat]);

  const submit = useCallback(
    async (answer: string) => {
      if (!pending) return;
      const trimmed = answer.trim();
      if (!trimmed) return;
      await IpcClient.getInstance().submitUserQuestionAnswer(
        chatId,
        pending.questionId,
        trimmed,
        pending.question,
      );
      setFreezeBaselineByChat((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      clearPending();
    },
    [chatId, pending, clearPending, setFreezeBaselineByChat],
  );

  if (!pending) {
    return null;
  }

  return (
    <div
      className="mb-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 space-y-3"
      role="region"
      aria-label="Assistant question"
    >
      <div className="flex items-start gap-2 text-sm">
        <MessageCircleQuestion className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
        <p className="text-foreground leading-relaxed">{pending.question}</p>
      </div>
      {pending.options && pending.options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {pending.options.map((opt, i) => (
            <Button
              key={`${pending.questionId}-${i}`}
              type="button"
              variant="secondary"
              size="sm"
              className="text-left h-auto py-2 whitespace-normal"
              onClick={() => void submit(opt)}
            >
              {opt}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          placeholder={
            pending.options?.length ? "Or type a different answer…" : "Your answer…"
          }
          value={customAnswer}
          onChange={(e) => setCustomAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(customAnswer);
            }
          }}
        />
        <Button type="button" size="sm" onClick={() => void submit(customAnswer)}>
          Send
        </Button>
      </div>
    </div>
  );
}
