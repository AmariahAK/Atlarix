/**
 * InlineUserQuestions (v11.1 end-turn) — ask_user question card rendered
 * inline in the chat thread. The asking TURN HAS ENDED by the time this
 * shows; answers are recorded as a real user message and a continuation
 * stream starts. The card also re-seeds itself from the persisted
 * `atlarix-questions` artifact after an app reload.
 */

import { InlineMarkdown } from "./InlineMarkdown";
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
import { useWorkModeSelection } from "@/hooks/useWorkModeSelection";
import { workModeChosenInAnswers } from "@/lib/work-mode";
import { extractQuestionsArtifact } from "@/lib/chat/ask-user-artifacts";
import {
  ASK_USER_MAX_OPTIONS,
  ASK_USER_SKIP_ANSWER,
  combineAskUserAnswers,
  joinAskUserPicks,
  readAskUserQuestions,
  type AskUserOption,
  type AskUserQuestion,
} from "@/lib/tools/ask_user_options";
import { cn } from "@/lib/utils";
import { Check, MessageCircleQuestion, Pencil } from "lucide-react";

type Props = {
  chatId: number;
};

type QuestionItem = AskUserQuestion & { options: AskUserOption[] };

function questionItems(pending: PendingUserQuestion): QuestionItem[] {
  const list =
    pending.questions && pending.questions.length > 0
      ? pending.questions
      : [{ question: pending.question, options: pending.options }];
  return readAskUserQuestions(list).map((q) => ({
    ...q,
    options: (q.options ?? []).slice(0, ASK_USER_MAX_OPTIONS),
  }));
}

export function InlineUserQuestions({ chatId }: Props) {
  const [pendingByChat, setPendingByChat] = useAtom(
    pendingUserQuestionByChatIdAtom,
  );
  // Scoped to this chat (perf): don't re-run on unrelated chats' stream flushes.
  const messagesForChat = useAtomValue(messagesForChatAtom(chatId));
  const isStreamingThisChat = useAtomValue(isStreamingForChatAtom(chatId));
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const { workMode, setWorkMode } = useWorkModeSelection();
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
  // Per-question answer state: selected option text OR custom text. A
  // multiSelect question's answer is its picked labels (in option order) plus
  // its typed text, joined with ", ".
  const [answers, setAnswers] = useState<string[]>([]);
  const [customDrafts, setCustomDrafts] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[][]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setAnswers(Array(items.length).fill(""));
    setCustomDrafts(Array(items.length).fill(""));
    setPicked(items.map(() => []));
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
        const combined = combineAskUserAnswers(items, finalAnswers);
        const res = await IpcClient.getInstance().submitUserQuestionAnswer(
          chatId,
          pending.questionId,
          combined,
          items.length === 1 ? items[0].question : `${items.length} questions`,
        );
        clearPending();
        // "Yes, switch to Build" is the user's own mode pick (W4): apply it, and
        // run the continuation in it rather than in the mode that asked.
        const mode = workModeChosenInAnswers(finalAnswers);
        if (mode && mode !== workMode) setWorkMode(mode);
        // The asking turn already ended — answers became a real user message;
        // start the continuation stream so the model picks the task back up.
        if (res?.restream) {
          streamMessage({
            prompt: "",
            chatId,
            continueAfterQuestions: true,
            ...(mode && mode !== workMode ? { workModeOverride: mode } : {}),
          });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [chatId, pending, items, submitting, clearPending, streamMessage, workMode, setWorkMode],
  );

  const pick = useCallback(
    (qi: number, value: string) => {
      const item = items[qi];
      const next = [...answers];
      if (item?.multiSelect) {
        // A toggle, never a send: the user may pick more.
        const was = picked[qi] ?? [];
        const now = was.includes(value) ? was.filter((l) => l !== value) : [...was, value];
        const ordered = item.options.map((o) => o.label).filter((l) => now.includes(l));
        const nextPicked = [...picked];
        nextPicked[qi] = ordered;
        setPicked(nextPicked);
        next[qi] = joinAskUserPicks(ordered, customDrafts[qi] ?? "");
        setAnswers(next);
        return;
      }
      next[qi] = value;
      setAnswers(next);
      // Single question + option click = immediate submit (fast path).
      if (items.length === 1 && value.trim()) {
        void submitAll(next);
      }
    },
    [answers, items, picked, customDrafts, submitAll],
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
          pick(0, opts[idx]!.label);
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
  const needsSubmit = multi || items[0].options.length === 0 || !!items[0].multiSelect;

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
        const labels = it.options.map((o) => o.label);
        const isCustomSelected = it.multiSelect
          ? (customDrafts[qi] ?? "").trim().length > 0
          : selected.trim().length > 0 && !labels.includes(selected);
        return (
          <div key={`${pending.questionId}-${qi}`} className="space-y-2">
            {it.header ? (
              <span
                className="inline-block rounded-sm bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
                data-testid={`ask-header-${qi}`}
              >
                {it.header}
              </span>
            ) : null}
            <p className="text-sm text-foreground leading-relaxed font-medium">
              {multi ? `${qi + 1}. ` : ""}
              {/* The model's question, marks drawn (QA #36: raw backticks). */}
              <InlineMarkdown text={it.question} />
            </p>

            {it.options.length > 0 ? (
              <div
                className="space-y-1.5"
                role="listbox"
                aria-label="Suggested answers"
                aria-multiselectable={it.multiSelect ? true : undefined}
              >
                {it.options.map((opt, oi) => {
                  const isSelected = it.multiSelect
                    ? (picked[qi] ?? []).includes(opt.label)
                    : selected === opt.label;
                  return (
                    <button
                      key={`${pending.questionId}-${qi}-${oi}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={submitting}
                      className={cn(
                        "w-full flex items-start gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        "hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isSelected && "border-primary bg-primary/10",
                      )}
                      onClick={() => pick(qi, opt.label)}
                    >
                      <span className="text-muted-foreground tabular-nums w-5 shrink-0">
                        {oi + 1}
                      </span>
                      <span className="flex-1 min-w-0 wrap-break-word">
                        <InlineMarkdown text={opt.label} />
                        {opt.recommended ? (
                          <span
                            className="ml-2 rounded-sm border border-primary/40 px-1 text-[10px] text-primary"
                            data-testid="ask-recommended"
                          >
                            Recommended
                          </span>
                        ) : null}
                        {opt.description ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {opt.description}
                          </span>
                        ) : null}
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
                  // Typing custom text selects it as this question's answer;
                  // in a multiSelect question it joins the picks.
                  const next = [...answers];
                  next[qi] = it.multiSelect
                    ? joinAskUserPicks(picked[qi] ?? [], e.target.value)
                    : e.target.value;
                  setAnswers(next);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (customDrafts[qi] ?? "").trim()) {
                    e.preventDefault();
                    if (items.length === 1) {
                      void submitAll([
                        it.multiSelect ? (answers[qi] ?? "") : (customDrafts[qi] ?? "").trim(),
                      ]);
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
              items.map((_it, i) => (answers[i] ?? "").trim() || ASK_USER_SKIP_ANSWER),
            )
          }
        >
          Skip {multi ? "remaining" : ""}
        </Button>
        {needsSubmit ? (
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
