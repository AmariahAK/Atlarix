import { useCallback, useEffect, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  pendingUserQuestionByChatIdAtom,
  askUserStreamFreezeBaselineByChatIdAtom,
  type PendingUserQuestion,
} from "@/atoms/chatAtoms";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { ASK_USER_MAX_OPTIONS } from "@/lib/tools/ask_user_options";
import { cn } from "@/lib/utils";
import { CornerDownLeft, MessageCircleQuestion, Pencil } from "lucide-react";

type Props = {
  chatId: number;
};

const SKIP_ANSWER = "(skipped)";

export function UserQuestionBar({ chatId }: Props) {
  const [pendingByChat, setPendingByChat] = useAtom(pendingUserQuestionByChatIdAtom);
  const setFreezeBaselineByChat = useSetAtom(askUserStreamFreezeBaselineByChatIdAtom);
  const pending: PendingUserQuestion | undefined = pendingByChat[chatId];
  const [customAnswer, setCustomAnswer] = useState("");
  const [focusedRow, setFocusedRow] = useState<number | "custom" | null>(null);

  const clearPending = useCallback(() => {
    setPendingByChat((prev) => {
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
    setCustomAnswer("");
    setFocusedRow(null);
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

  const options = (pending?.options ?? []).slice(0, ASK_USER_MAX_OPTIONS);

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key >= "1" && e.key <= "4" && options.length > 0) {
        const idx = Number(e.key) - 1;
        if (idx < options.length) {
          e.preventDefault();
          void submit(options[idx]!);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, options, submit]);

  if (!pending) {
    return null;
  }

  const hasOptions = options.length > 0;

  return (
    <div
      className="mb-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 space-y-3"
      role="region"
      aria-label="Assistant question"
    >
      <div className="flex items-start gap-2 text-sm">
        <MessageCircleQuestion className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
        <p className="text-foreground leading-relaxed font-medium">{pending.question}</p>
      </div>

      {hasOptions ? (
        <div className="space-y-1.5" role="listbox" aria-label="Suggested answers">
          {options.map((opt, i) => (
            <button
              key={`${pending.questionId}-${i}`}
              type="button"
              role="option"
              className={cn(
                "w-full flex items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
                "hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                focusedRow === i && "bg-accent border-border",
              )}
              onClick={() => void submit(opt)}
              onFocus={() => setFocusedRow(i)}
            >
              <span className="text-muted-foreground tabular-nums w-5 shrink-0">{i + 1}</span>
              <span className="flex-1 min-w-0 wrap-break-word">{opt}</span>
              {focusedRow === i ? (
                <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-3 py-2",
          focusedRow === "custom" && "ring-2 ring-ring",
        )}
      >
        <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder={hasOptions ? "Something else" : "Your answer…"}
          value={customAnswer}
          onChange={(e) => setCustomAnswer(e.target.value)}
          onFocus={() => setFocusedRow("custom")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(customAnswer);
            }
          }}
        />
        {customAnswer.trim() ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 shrink-0"
            onClick={() => void submit(customAnswer)}
          >
            Send
          </Button>
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => void submit(SKIP_ANSWER)}
        >
          Skip
        </Button>
      </div>
    </div>
  );
}
