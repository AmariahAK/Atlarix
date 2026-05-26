import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { chatIdToSessionIdAtom } from "@/atoms/sessionAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import type { PlanArtifactPayload } from "@/ipc/utils/emit_plan_artifact";
import { PlanArtifactCard } from "./PlanArtifactCard";
import { InlinePlanArtifactSlot } from "./InlinePlanArtifactSlot";
import { extractPlanIdsFromContent } from "@/lib/plan-cards/plan-card-renderer";

/** Legacy top-of-message plan markers (prefer inline slots in AtlarixMarkdownParser). */
export function PlanArtifactMarkers({
  content,
  chatId,
  onBuild,
  buildDisabled,
}: {
  content: string;
  chatId: number;
  onBuild?: (planId: string) => void;
  buildDisabled?: boolean;
}) {
  const planIds = extractPlanIdsFromContent(content);
  if (!planIds.length) return null;

  return (
    <div className="space-y-1">
      {planIds.map((id) => (
        <InlinePlanArtifactSlot
          key={id}
          planId={id}
          chatId={chatId}
          onBuild={onBuild}
          buildDisabled={buildDisabled}
        />
      ))}
    </div>
  );
}

/** @deprecated use extractPlanIdsFromContent */
export function extractPlanIds(content: string): string[] {
  return extractPlanIdsFromContent(content);
}
