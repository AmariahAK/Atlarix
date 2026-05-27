import { Hammer, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanArtifactStatus } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { VisualArtifactCard } from "./VisualArtifactCard";
import { AtlarixMarkdownSegment } from "./AtlarixMarkdownSegment";

const LIFECYCLE_STEPS: { key: PlanArtifactStatus; label: string }[] = [
  { key: "plan", label: "TBD" },
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
                <Loader2 className="h-3 w-3 animate-spin shrink-0" aria-hidden />
              ) : null}
              {step.label}
            </span>
          </span>
        );
      })}
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
