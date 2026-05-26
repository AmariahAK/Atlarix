import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { chatIdToSessionIdAtom } from "@/atoms/sessionAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import type { PlanArtifactPayload } from "@/ipc/utils/emit_plan_artifact";
import { Loader2 } from "lucide-react";
import { VisualArtifactCard } from "./VisualArtifactCard";
import { Button } from "@/components/ui/button";
import { Hammer, ClipboardList, CircleCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export function InlinePlanArtifactSlot({
  planId,
  chatId,
  onBuild,
  buildDisabled,
}: {
  planId: string;
  chatId: number | null | undefined;
  onBuild?: (planId: string) => void;
  buildDisabled?: boolean;
}) {
  const chatMap = useAtomValue(chatIdToSessionIdAtom);
  const _sessionId = chatId != null ? (chatMap.get(chatId) ?? "") : "";
  const [plan, setPlan] = useState<PlanArtifactPayload | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setPlan(undefined);
    void (async () => {
      const row = await IpcClient.getInstance().getPlanArtifact(planId);
      if (!cancelled) setPlan(row ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [planId]);

  if (plan === undefined) {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden />
        Loading plan…
      </div>
    );
  }

  if (plan === null) {
    return (
      <div className="my-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        Plan not found ({planId.slice(0, 8)}…). It may still be saving.
      </div>
    );
  }

  const statusLabel =
    plan.planStatus === "building"
      ? "Building"
      : plan.planStatus === "built"
        ? "Built"
        : "Plan";

  const StatusIcon =
    plan.planStatus === "building"
      ? () => <Hammer className="h-3.5 w-3.5 shrink-0" aria-hidden />
      : plan.planStatus === "built"
        ? () => (
            <CircleCheck
              className="h-3.5 w-3.5 shrink-0 text-emerald-500"
              aria-hidden
            />
          )
        : () => <ClipboardList className="h-3.5 w-3.5 shrink-0" aria-hidden />;

  const title =
    plan.content.split("\n")[0]?.replace(/^#+\s*/, "").trim() ||
    "Implementation plan";
  const preview = plan.content.slice(0, 200).trim();

  const canBuild = plan.planStatus !== "built" && onBuild != null;

  return (
    <div className="my-2">
      <VisualArtifactCard title={title} defaultExpanded={false} layout="content" className="bg-card/40">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <StatusIcon />
            <span className={cn("text-[10px] uppercase tracking-wide text-muted-foreground ml-auto")}>
              {statusLabel}
            </span>
          </div>
          {preview ? (
            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{preview}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {canBuild ? (
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-7 text-xs gap-1"
                disabled={buildDisabled}
                onClick={(e) => {
                  e.stopPropagation();
                  onBuild?.(plan.planId);
                }}
              >
                <Hammer className="h-3 w-3" aria-hidden />
                Build
              </Button>
            ) : null}
          </div>
        </div>
      </VisualArtifactCard>
    </div>
  );
}
