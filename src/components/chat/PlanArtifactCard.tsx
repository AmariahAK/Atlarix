import { ClipboardList, Hammer, CircleCheck, Loader2, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanArtifactStatus } from "@/db/schema";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { VisualArtifactCard } from "./VisualArtifactCard";

const STATUS_LABEL: Record<PlanArtifactStatus, string> = {
  plan: "Plan",
  building: "Building",
  built: "Built",
};

function StatusIcon({ status }: { status: PlanArtifactStatus }) {
  if (status === "building") {
    return <Hammer className="h-3.5 w-3.5 shrink-0" aria-hidden />;
  }
  if (status === "built") {
    return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />;
  }
  return <ClipboardList className="h-3.5 w-3.5 shrink-0" aria-hidden />;
}

export function PlanArtifactCard({
  planId,
  title,
  preview,
  planStatus,
  onBuild,
  buildDisabled,
}: {
  planId: string;
  title?: string;
  preview?: string;
  planStatus: PlanArtifactStatus;
  onBuild?: (planId: string) => void;
  buildDisabled?: boolean;
}) {
  const canPreview = Boolean(preview?.trim());

  const canBuild = planStatus !== "built" && onBuild != null;

  return (
    <VisualArtifactCard
      title={title?.trim() || "Implementation plan"}
      defaultExpanded={false}
      layout="content"
      className="bg-card/40"
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <StatusIcon status={planStatus} />
          <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            {planStatus === "building" ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : null}
            {STATUS_LABEL[planStatus]}
          </span>
        </div>
        {preview?.trim() ? (
          <p className="text-xs text-muted-foreground whitespace-pre-wrap">
            {preview.trim()}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {/* Preview is inline via VisualArtifactCard expand; no right panel jump. */}
          {canPreview ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
              <Eye className="h-3 w-3" aria-hidden />
              Preview inline
            </span>
          ) : null}
          {canBuild ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-7 text-xs gap-1"
              disabled={buildDisabled}
              onClick={(e) => {
                e.stopPropagation();
                onBuild(planId);
              }}
            >
              <Hammer className="h-3 w-3" aria-hidden />
              Build
            </Button>
          ) : null}
        </div>
      </div>
    </VisualArtifactCard>
  );
}
