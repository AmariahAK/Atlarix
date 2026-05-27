import { useEffect, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import type { PlanArtifactPayload } from "@/ipc/utils/emit_plan_artifact";
import { Loader2 } from "lucide-react";
import {
  PlanArtifactCard,
  planArtifactTitleFromContent,
} from "./PlanArtifactCard";

export function InlinePlanArtifactSlot({
  planId,
  chatId: _chatId,
  onBuild,
  buildDisabled,
}: {
  planId: string;
  chatId: number | null | undefined;
  onBuild?: (planId: string) => void;
  buildDisabled?: boolean;
  /** @deprecated Plans render fully inline; no right panel. */
  onOpenDetail?: (planId: string) => void;
}) {
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
        className="my-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground not-prose"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden />
        Loading plan…
      </div>
    );
  }

  if (plan === null) {
    return (
      <div className="my-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive not-prose">
        Plan not found ({planId.slice(0, 8)}…). It may still be saving.
      </div>
    );
  }

  return (
    <div className="not-prose my-2 w-full">
      <PlanArtifactCard
        planId={plan.planId}
        title={planArtifactTitleFromContent(plan.content)}
        content={plan.content}
        planStatus={plan.planStatus}
        onBuild={onBuild}
        buildDisabled={buildDisabled}
        defaultExpanded={false}
      />
    </div>
  );
}
