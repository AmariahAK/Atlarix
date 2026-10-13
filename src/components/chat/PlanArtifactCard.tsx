import { useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Hammer,
  Loader2,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanArtifactStatus } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { VisualArtifactCard } from "./VisualArtifactCard";
import { AtlarixMarkdownSegment } from "./AtlarixMarkdownSegment";
import {
  parsePlanChecklist,
  type PlanChecklistStep,
} from "@/lib/tasks/plan-checklist";

const LIFECYCLE_STEPS: { key: PlanArtifactStatus; label: string }[] = [
  // As the CLI says it; "TBD" read as unfinished (QA #17).
  { key: "plan", label: "Ready to build" },
  { key: "building", label: "Building" },
  { key: "built", label: "Completed" },
];

const STEP_INDEX: Record<PlanArtifactStatus, number> = {
  plan: 0,
  building: 1,
  built: 2,
};

function PlanStatusStrip({ planStatus }: { planStatus: PlanArtifactStatus }) {
  const currentIdx = STEP_INDEX[planStatus];

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-2.5 py-2 text-[11px]"
      role="status"
      aria-label={`Plan status: ${LIFECYCLE_STEPS[currentIdx]?.label ?? planStatus}`}
    >
      {LIFECYCLE_STEPS.map((step, idx) => {
        const isCurrent = idx === currentIdx;
        const isPast = idx < currentIdx;
        const isFuture = idx > currentIdx;
        return (
          <span key={step.key} className="inline-flex items-center gap-1.5">
            {idx > 0 ? (
              <span className="text-muted-foreground/50" aria-hidden>
                →
              </span>
            ) : null}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium",
                isCurrent &&
                  "border border-primary/40 bg-primary/10 text-foreground",
                isPast && "text-muted-foreground",
                isFuture && "text-muted-foreground/50",
              )}
            >
              {isCurrent && planStatus === "building" ? (
                <Loader2
                  className="h-3 w-3 animate-spin shrink-0"
                  aria-hidden
                />
              ) : null}
              {step.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function StepIcon({ state }: { state: PlanChecklistStep["state"] }) {
  switch (state) {
    case "done":
      return (
        <CheckCircle2
          className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-500"
          aria-hidden
        />
      );
    case "in_progress":
      return (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
          aria-hidden
        />
      );
    case "blocked":
      return (
        <AlertTriangle
          className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500"
          aria-hidden
        />
      );
    // Handed back to the user — a person, not a warning. Distinct icon AND colour
    // from `blocked`, because the two mean different things to whoever is reading.
    case "external":
      return (
        <UserRound
          className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400"
          aria-hidden
        />
      );
    default:
      return (
        <Circle
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
          aria-hidden
        />
      );
  }
}

/** v10: live per-step progress while the agent builds the plan. */
export function PlanChecklistProgress({
  content,
  planStatus,
}: {
  content: string;
  planStatus: PlanArtifactStatus;
}) {
  const steps = useMemo(() => parsePlanChecklist(content), [content]);
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.state === "done").length;
  // Counted and shown separately: "3/4 done" alone reads as unfinished work when the
  // 4th step is the user's, which is exactly the wrong impression.
  const external = steps.filter((s) => s.state === "external").length;
  const started =
    steps.some((s) => s.state !== "todo") || planStatus !== "plan";
  if (!started) return null;

  const externalLabel = external > 0 ? ` · ${external} needs you` : "";

  return (
    <div
      className="rounded-md border border-border/40 bg-muted/20 px-2.5 py-2"
      role="status"
      aria-label={`Plan steps: ${done} of ${steps.length} done${
        external > 0 ? `, ${external} needs you` : ""
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>Steps</span>
        <span>
          {done}/{steps.length} done{externalLabel}
        </span>
      </div>
      <ul className="space-y-1">
        {steps.map((step) => (
          <li
            key={`${step.index}-${step.line}`}
            className="flex items-start gap-1.5 text-xs"
          >
            <span className="mt-0.5">
              <StepIcon state={step.state} />
            </span>
            <span
              className={cn(
                "min-w-0 break-words",
                step.state === "done" &&
                  "text-muted-foreground line-through decoration-muted-foreground/40",
                step.state === "in_progress" && "text-foreground font-medium",
                step.state === "blocked" &&
                  "text-amber-700 dark:text-amber-400",
                step.state === "external" && "text-sky-700 dark:text-sky-300",
                step.state === "todo" && "text-muted-foreground",
              )}
            >
              {step.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function planArtifactTitleFromContent(content: string): string {
  const first = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.replace(/^#+\s*/, "").trim() || "Implementation plan";
}

export function PlanArtifactCard({
  planId,
  title,
  content,
  planStatus,
  onBuild,
  buildDisabled,
  defaultExpanded = false,
}: {
  planId: string;
  title?: string;
  content: string;
  planStatus: PlanArtifactStatus;
  onBuild?: (planId: string) => void;
  buildDisabled?: boolean;
  defaultExpanded?: boolean;
}) {
  const displayTitle = title?.trim() || planArtifactTitleFromContent(content);
  const canBuild = planStatus !== "built" && onBuild != null;

  return (
    <VisualArtifactCard
      title={displayTitle}
      defaultExpanded={defaultExpanded}
      layout="content"
      className="bg-card/40 not-prose"
    >
      <div className="space-y-3">
        <PlanStatusStrip planStatus={planStatus} />
        <PlanChecklistProgress content={content} planStatus={planStatus} />
        {content.trim() ? (
          <AtlarixMarkdownSegment content={content} isStreaming={false} />
        ) : null}
        {canBuild ? (
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/30">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-7 text-xs gap-1"
              disabled={buildDisabled}
              onClick={() => onBuild(planId)}
            >
              <Hammer className="h-3 w-3" aria-hidden />
              Build
            </Button>
          </div>
        ) : null}
      </div>
    </VisualArtifactCard>
  );
}
