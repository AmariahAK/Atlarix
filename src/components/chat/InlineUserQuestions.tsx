/**
 * InlineUserQuestions (v11.1 end-turn) — ask_user question card rendered
 * inline in the chat thread. The asking TURN HAS ENDED by the time this
 * shows; answers are recorded as a real user message and a continuation
 * stream starts. The card also re-seeds itself from the persisted
 * `atlarix-questions` artifact after an app reload.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  messagesForChatAtom,
  isStreamingForChatAtom,
  pendingUserQuestionByChatIdAtom,
  type PendingUserQuestion,
} from "@/atoms/chatAtoms";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { useStreamChat } from "@/hooks/useStreamChat";
import { extractQuestionsArtifact } from "@/lib/chat/ask-user-artifacts";
import { ASK_USER_MAX_OPTIONS } from "@/lib/tools/ask_user_options";
import { cn } from "@/lib/utils";
import { Check, MessageCircleQuestion, Pencil } from "lucide-react";

type Props = {
  chatId: number;
};

const SKIP_ANSWER = "(skipped)";

type QuestionItem = { question: string; options: string[] };

function questionItems(pending: PendingUserQuestion): QuestionItem[] {
  const list =
    pending.questions && pending.questions.length > 0
      ? pending.questions
      : [{ question: pending.question, options: pending.options }];
  return list.map((q) => ({
    question: q.question,
    options: (q.options ?? []).slice(0, ASK_USER_MAX_OPTIONS),
  }));
}

/** Combined readable answer string the model receives (and the Q&A bubble shows). */
function combineAnswers(items: QuestionItem[], answers: string[]): string {
  if (items.length === 1) return answers[0] ?? "";
  return items
    .map((it, i) => `Q: ${it.question}\nA: ${answers[i] ?? SKIP_ANSWER}`)
    .join("\n\n");
}

export function InlineUserQuestions({ chatId }: Props) {
  const [pendingByChat, setPendingByChat] = useAtom(
    pendingUserQuestionByChatIdAtom,
  );
  // Scoped to this chat (perf): don't re-run on unrelated chats' stream flushes.
  const messagesForChat = useAtomValue(messagesForChatAtom(chatId));
  const isStreamingThisChat = useAtomValue(isStreamingForChatAtom(chatId));
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const pending: PendingUserQuestion | undefined = pendingByChat[chatId];

  // Reload durability: when the last message is an assistant turn that ended
  // with an ask_user call, its persisted `atlarix-questions` artifact re-seeds
  // the card (a following user message means the questions were answered).
  useEffect(() => {
    if (pending) return;
    // A live stream supersedes any persisted question state.
    if (isStreamingThisChat) return;
    const messages = messagesForChat;
    if (!messages || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== "assistant") return;
    const artifact = extractQuestionsArtifact(last.content);
    if (!artifact) return;
    setPendingByChat((prev) => {
      if (prev[chatId]) return prev;
      return {
        ...prev,
        [chatId]: {
          questionId: artifact.questionId,
          question: artifact.questions[0]?.question ?? "",
          options: artifact.questions[0]?.options,
          questions: artifact.questions,
        },
      };
    });
  }, [pending, messagesForChat, isStreamingThisChat, chatId, setPendingByChat]);

  const items = useMemo(
    () => (pending ? questionItems(pending) : []),
    [pending],
  );
  // Per-question answer state: selected option text OR custom text.
  const [answers, setAnswers] = useState<string[]>([]);
  const [customDrafts, setCustomDrafts] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setAnswers(Array(items.length).fill(""));
    setCustomDrafts(Array(items.length).fill(""));
    setSubmitting(false);
  }, [pending?.questionId, items.length]);

  const clearPending = useCallback(() => {
    setPendingByChat((prev) => {
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  }, [chatId, setPendingByChat]);

  const submitAll = useCallback(
    async (finalAnswers: string[]) => {
      if (!pending || submitting) return;
      setSubmitting(true);
      try {
        const combined = combineAnswers(items, finalAnswers);
        const res = await IpcClient.getInstance().submitUserQuestionAnswer(
          chatId,
          pending.questionId,
          combined,
          items.length === 1 ? items[0].question : `${items.length} questions`,
        );
        clearPending();
        // The asking turn already ended — answers became a real user message;
        // start the continuation stream so the model picks the task back up.
        if (res?.restream) {
          streamMessage({ prompt: "", chatId, continueAfterQuestions: true });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [chatId, pending, items, submitting, clearPending, streamMessage],
  );

  const pick = useCallback(
    (qi: number, value: string) => {
      const next = [...answers];
      next[qi] = value;
      setAnswers(next);
      // Single question + option click = immediate submit (fast path).
      if (items.length === 1 && value.trim()) {
        void submitAll(next);
      }
    },
    [answers, items.length, submitAll],
  );

  // Number keys 1-4 pick options for single-question prompts.
  useEffect(() => {
    if (!pending || items.length !== 1) return;
    const opts = items[0].options;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      )
        return;
      if (e.key >= "1" && e.key <= "4" && opts.length > 0) {
        const idx = Number(e.key) - 1;
        if (idx < opts.length) {
          e.preventDefault();
          pick(0, opts[idx]!);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, items, pick]);

  if (!pending || items.length === 0) {
    return null;
  }

  const allAnswered = items.every(
    (_it, i) => (answers[i] ?? "").trim().length > 0,
  );
  const multi = items.length > 1;

  return (
    <div
      className="my-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 space-y-4"
      role="region"
      aria-label="Assistant questions"
      data-testid="inline-user-questions"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-primary">
        <MessageCircleQuestion className="h-4 w-4 shrink-0" />
        {multi
          ? `${items.length} questions — answer all to continue`
          : "Question"}
      </div>

      {items.map((it, qi) => {
        const selected = answers[qi] ?? "";
        const isCustomSelected =
          selected.trim().length > 0 && !it.options.includes(selected);
        return (
          <div key={`${pending.questionId}-${qi}`} className="space-y-2">
            <p className="text-sm text-foreground leading-relaxed font-medium">
              {multi ? `${qi + 1}. ` : ""}
              {it.question}
            </p>

            {it.options.length > 0 ? (
              <div
                className="space-y-1.5"
                role="listbox"
                aria-label="Suggested answers"
              >
                {it.options.map((opt, oi) => {
                  const isSelected = selected === opt;
                  return (
                    <button
                      key={`${pending.questionId}-${qi}-${oi}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={submitting}
                      className={cn(
                        "w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        "hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isSelected && "border-primary bg-primary/10",
                      )}
                      onClick={() => pick(qi, opt)}
                    >
                      <span className="text-muted-foreground tabular-nums w-5 shrink-0">
                        {oi + 1}
                      </span>
                      <span className="flex-1 min-w-0 wrap-break-word">
                        {opt}
                      </span>
                      {isSelected ? (
                        <Check className="h-4 w-4 shrink-0 text-primary" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-2",
                isCustomSelected && "border-primary bg-primary/10",
              )}
            >
              <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                type="text"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                placeholder={
                  it.options.length > 0 ? "Something else" : "Your answer…"
                }
                value={customDrafts[qi] ?? ""}
                disabled={submitting}
                onChange={(e) => {
                  const drafts = [...customDrafts];
                  drafts[qi] = e.target.value;
                  setCustomDrafts(drafts);
                  // Typing custom text selects it as this question's answer.
                  const next = [...answers];
                  next[qi] = e.target.value;
                  setAnswers(next);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (customDrafts[qi] ?? "").trim()) {
                    e.preventDefault();
                    if (items.length === 1) {
                      void submitAll([(customDrafts[qi] ?? "").trim()]);
                    }
                  }
                }}
              />
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={submitting}
          onClick={() =>
            void submitAll(
              items.map((_it, i) => (answers[i] ?? "").trim() || SKIP_ANSWER),
            )
          }
        >
          Skip {multi ? "remaining" : ""}
        </Button>
        {multi || items[0].options.length === 0 ? (
          <Button
            type="button"
            size="sm"
            disabled={!allAnswered || submitting}
            onClick={() => void submitAll(answers.map((a) => a.trim()))}
            data-testid="inline-user-questions-submit"
          >
            {submitting ? "Sending…" : "Submit answers"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
