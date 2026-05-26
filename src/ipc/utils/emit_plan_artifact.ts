import type { WebContents } from "electron";
import type { PlanArtifactStatus } from "@/db/schema";
import { safeSend } from "./safe_sender";

export type PlanArtifactPayload = {
  planId: string;
  sessionId: string;
  content: string;
  planStatus: PlanArtifactStatus;
};

export function emitPlanArtifactActivated(
  sender: WebContents,
  payload: PlanArtifactPayload,
): void {
  safeSend(sender, "plan:artifact-activated", payload);
}

export function emitPlanArtifactUpdated(
  sender: WebContents,
  payload: PlanArtifactPayload,
): void {
  safeSend(sender, "plan:artifact-updated", payload);
}
