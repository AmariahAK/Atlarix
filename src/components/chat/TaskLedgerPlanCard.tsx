import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TaskLedgerPlanStep {
  id: number;
  description: string;
  status: "pending" | "in_progress" | "done" | "failed";
  completedAt?: number;
}

export interface TaskLedgerPlanCardProps {
  task: string;
  steps: TaskLedgerPlanStep[];
  status: "pending" | "in_progress" | "complete" | "failed";
  createdAt?: number;
  /** True while plan is actively executing */
  isLive?: boolean;
  /** Header + progress only; steps behind expand */
  collapsed?: boolean;
}

export function TaskLedgerPlanCard({
  task,
  steps,
  status,
  isLive,
  collapsed: collapsedProp,
}: TaskLedgerPlanCardProps) {
  const [expanded, setExpanded] = useState(!collapsedProp);
  const collapsed = collapsedProp === true;
  const done = steps.filter((s) => s.status === "done").length;
  const total = steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const showSteps = !collapsed || expanded;

  return (
    <div className="plan-card">
      <div className="plan-card-header">
        {collapsed ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="plan-card-expand-toggle"
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            )}
          </button>
        ) : (
          <span className="plan-card-icon" aria-hidden>
            📋
          </span>
        )}
        <span className="plan-card-title">Plan</span>
        {isLive ? <span className="plan-card-live">● Live</span> : null}
        <span className="plan-card-progress">
          {done}/{total} steps
        </span>
      </div>

      {showSteps ? (
        <>
          <p className="plan-card-task">{task}</p>
          {total > 0 ? (
            <div className="plan-progress-track">
              <div className="plan-progress-fill" style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          <ol className="plan-steps">
            {steps.map((step, i) => (
              <li
                key={step.id}
                className={cn("plan-step", `plan-step--${step.status}`)}
              >
                <span className="plan-step-marker">
                  {step.status === "done"
                    ? "✓"
                    : step.status === "failed"
                      ? "✗"
                      : step.status === "in_progress"
                        ? "◌"
                        : `${i + 1}`}
                </span>
                <span className="plan-step-text">{step.description}</span>
                {step.status === "in_progress" ? (
                  <span className="plan-step-active">in progress</span>
                ) : null}
              </li>
            ))}
          </ol>
          {status === "complete" ? (
            <div className="plan-card-complete">✓ Plan complete</div>
          ) : null}
        </>
      ) : (
        <div className="plan-progress-track plan-progress-track--tight">
          <div className="plan-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
