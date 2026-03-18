/**
 * QuestionsWidget — v3.9 clarifying questions from AI
 * Renders below the AI message bubble; user selects choices or enters "Other", then Continue.
 */

import { useState } from "react";
import type { Question } from "@/ipc/ipc_types";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface QuestionsWidgetProps {
  messageId: number;
  questions: Question[];
  onSubmit: (answers: Record<string, string>) => void;
}

export function QuestionsWidget({ messageId, questions, onSubmit }: QuestionsWidgetProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string>>({});

  const handleSelect = (questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setCustomValues((prev) => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  };

  const handleCustomChange = (questionId: string, value: string) => {
    setCustomValues((prev) => ({ ...prev, [questionId]: value }));
    if (value.trim()) {
      setAnswers((prev) => ({ ...prev, [questionId]: value.trim() }));
    } else {
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
    }
  };

  const allAnswered = questions.every((q) => {
    const a = answers[q.id];
    if (a) return true;
    if (q.allowCustom && customValues[q.id]?.trim()) return true;
    return false;
  });

  const handleContinue = () => {
    const final: Record<string, string> = {};
    questions.forEach((q) => {
      const a = answers[q.id];
      const custom = q.allowCustom ? customValues[q.id]?.trim() : undefined;
      final[q.id] = a ?? custom ?? "";
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
          "rounded-lg border border-border bg-muted/30 text-sm",
          "max-w-3xl mx-auto mt-2"
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-muted-foreground hover:text-foreground"
        >
          <span>Questions answered ✓</span>
          {collapsed ? (
            <ChevronDown className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronUp className="h-4 w-4 shrink-0" />
          )}
        </button>
        {!collapsed && (
          <div className="px-4 pb-3 pt-0 space-y-2 border-t border-border/50">
            {questions.map((q) => (
              <div key={q.id} className="text-muted-foreground">
                <span className="font-medium text-foreground">Q: </span>
                {q.question}{" "}
                <span className="font-medium text-foreground">A: </span>
                {submittedAnswers[q.id] ?? "—"}
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
        "rounded-lg border border-border bg-card shadow-sm p-4",
        "max-w-3xl mx-auto mt-2 space-y-4"
      )}
      data-message-id={messageId}
    >
      {questions.map((q) => (
        <div key={q.id} className="space-y-2">
          <label className="text-sm font-medium text-foreground block">{q.question}</label>
          <div className="flex flex-wrap gap-2">
            {q.choices.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => handleSelect(q.id, choice)}
                className={cn(
                  "px-3 py-1.5 rounded-full text-sm border transition-colors",
                  answers[q.id] === choice
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {choice}
              </button>
            ))}
          </div>
          {q.allowCustom && (
            <div className="pt-1">
              <label className="text-xs text-muted-foreground block mb-1">Other:</label>
              <input
                type="text"
                value={customValues[q.id] ?? ""}
                onChange={(e) => handleCustomChange(q.id, e.target.value)}
                placeholder="Type your answer..."
                className="w-full max-w-md px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
        </div>
      ))}
      <div className="pt-2">
        <Button
          size="sm"
          onClick={handleContinue}
          disabled={!allAnswered}
          className="gap-1.5"
        >
          Continue →
        </Button>
      </div>
    </div>
  );
}
