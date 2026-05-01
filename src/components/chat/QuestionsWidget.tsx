/**
 * QuestionsWidget — clarifying questions from AI (<questions> block).
 * SpacGPT-inspired layout: block title, per-question radio options + Other, primary submit.
 */

import { useState } from "react";
import type { Question } from "@/ipc/ipc_types";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

const OTHER_SENTINEL = "__atlarix_other__";

interface QuestionsWidgetProps {
  messageId: number;
  questions: Question[];
  /** Optional heading from model JSON (`title` / `prompt`). */
  title?: string;
  onSubmit: (answers: Record<string, string>) => void;
}

const DEFAULT_BLOCK_TITLE = "A few quick questions";

export function QuestionsWidget({
  messageId,
  questions,
  title,
  onSubmit,
}: QuestionsWidgetProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string>>({});

  const blockTitle = title?.trim() || DEFAULT_BLOCK_TITLE;

  const handlePickChoice = (questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    if (value !== OTHER_SENTINEL) {
      setCustomValues((prev) => {
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
    }
  };

  const handleOtherInputChange = (questionId: string, value: string) => {
    setCustomValues((prev) => ({ ...prev, [questionId]: value }));
    setAnswers((prev) => ({ ...prev, [questionId]: OTHER_SENTINEL }));
  };

  const allAnswered = questions.every((q) => {
    const a = answers[q.id];
    if (!a) return false;
    if (a === OTHER_SENTINEL) return !!customValues[q.id]?.trim();
    return true;
  });

  const handleContinue = () => {
    const final: Record<string, string> = {};
    questions.forEach((q) => {
      const a = answers[q.id];
      if (a === OTHER_SENTINEL) {
        final[q.id] = customValues[q.id]?.trim() ?? "";
      } else {
        final[q.id] = a ?? "";
      }
    });
    setSubmittedAnswers(final);
    setSubmitted(true);
    setCollapsed(true);
    onSubmit(final);
  };

  if (submitted) {
    return (
      <div
        className={cn(
          "rounded-xl border border-border bg-muted/20 text-sm",
          "max-w-3xl mx-auto mt-2 overflow-hidden",
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 w-full px-4 py-3 text-left text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
        >
          <span className="font-medium text-foreground">Questions answered</span>
          <span className="text-primary">✓</span>
          {collapsed ? (
            <ChevronDown className="h-4 w-4 shrink-0 ml-auto" />
          ) : (
            <ChevronUp className="h-4 w-4 shrink-0 ml-auto" />
          )}
        </button>
        {!collapsed && (
          <div className="px-4 pb-4 pt-0 space-y-3 border-t border-border/60">
            {questions.map((q) => (
              <div key={q.id} className="text-sm">
                <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">
                  {q.question}
                </div>
                <div className="text-foreground">{submittedAnswers[q.id] ?? "—"}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card shadow-sm",
        "max-w-3xl mx-auto mt-2 overflow-hidden",
      )}
      data-message-id={messageId}
    >
      <div className="border-b border-border/70 bg-muted/25 px-4 py-3">
        <h4 className="text-sm font-semibold text-foreground tracking-tight">{blockTitle}</h4>
      </div>
      <div className="p-4 space-y-6">
        {questions.map((q) => {
          const qid = q.id;
          const picked = answers[qid];
          const isOther = picked === OTHER_SENTINEL;
          const choicesFiltered = q.choices.filter(
            (c) => String(c).trim().toLowerCase() !== "other",
          );
          return (
            <fieldset key={qid} className="space-y-3 min-w-0">
              <legend className="text-sm font-medium text-foreground text-left w-full mb-0">
                {q.question}
              </legend>
              <div className="flex flex-col gap-2" role="radiogroup" aria-label={q.question}>
                {choicesFiltered.map((choice) => {
                  const selected = picked === choice;
                  return (
                    <label
                      key={choice}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors",
                        selected
                          ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                          : "border-border bg-background hover:bg-muted/40",
                      )}
                    >
                      <input
                        type="radio"
                        name={`atlarix-q-${messageId}-${qid}`}
                        className="h-4 w-4 shrink-0 accent-primary"
                        checked={selected}
                        onChange={() => handlePickChoice(qid, choice)}
                      />
                      <span className="text-sm text-foreground">{choice}</span>
                    </label>
                  );
                })}
                {q.allowCustom && (
                  <label
                    className={cn(
                      "flex flex-col gap-2 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors sm:flex-row sm:items-center",
                      isOther
                        ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                        : "border-border bg-background hover:bg-muted/40",
                    )}
                  >
                    <div className="flex items-center gap-3 shrink-0">
                      <input
                        type="radio"
                        name={`atlarix-q-${messageId}-${qid}`}
                        className="h-4 w-4 shrink-0 accent-primary"
                        checked={isOther}
                        onChange={() => handlePickChoice(qid, OTHER_SENTINEL)}
                      />
                      <span className="text-sm font-medium text-foreground">Other</span>
                    </div>
                    <input
                      type="text"
                      value={customValues[qid] ?? ""}
                      placeholder="Type your answer…"
                      onFocus={() => handlePickChoice(qid, OTHER_SENTINEL)}
                      onChange={(e) => handleOtherInputChange(qid, e.target.value)}
                      className={cn(
                        "flex-1 min-w-0 px-3 py-2 rounded-md border border-border bg-background text-sm",
                        "focus:outline-none focus:ring-2 focus:ring-ring",
                      )}
                    />
                  </label>
                )}
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="px-4 pb-4 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={handleContinue} disabled={!allAnswered} className="gap-1.5">
          Submit answers
        </Button>
      </div>
    </div>
  );
}
