import { ipcMain, BrowserWindow } from "electron";
import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import {
  createPlanArtifact,
  getPlanArtifact,
  listPlanArtifactsForSession,
  setPlanArtifactStatus,
  updatePlanArtifactContent,
  appendStepToPlanArtifact,
  type PlanArtifactRow,
} from "@/lib/plans/plan-artifacts";
import type { PlanArtifactStatus } from "@/db/schema";
import {
  emitPlanArtifactActivated,
  type PlanArtifactPayload,
} from "../utils/emit_plan_artifact";

const logger = log.scope("plan-artifacts");
const handle = createLoggedHandler(logger);

function toPayload(row: PlanArtifactRow): PlanArtifactPayload {
  return {
    planId: row.id,
    sessionId: row.sessionId,
    content: row.content,
    planStatus: row.planStatus,
  };
}

function broadcastPlanEvent(
  channel: "plan:artifact-activated" | "plan:artifact-updated",
  payload: PlanArtifactPayload,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export function registerPlanArtifactHandlers(): void {
  handle(
    "plans:create",
    async (
      _event,
      params: { sessionId: string; content: string; title?: string },
    ): Promise<PlanArtifactPayload> => {
      const row = await createPlanArtifact(params.sessionId, params.content, params.title);
      const payload = toPayload(row);
      broadcastPlanEvent("plan:artifact-updated", payload);
      return payload;
    },
  );

  handle(
    "plans:update",
    async (
      _event,
      params: { planId: string; content: string },
    ): Promise<PlanArtifactPayload> => {
      const row = await updatePlanArtifactContent(params.planId, params.content);
      if (!row) throw new Error("Plan artifact not found");
      const payload = toPayload(row);
      broadcastPlanEvent("plan:artifact-updated", payload);
      return payload;
    },
  );

  handle(
    "plans:append-step",
    async (
      _event,
      params: { planId: string; stepText: string },
    ): Promise<PlanArtifactPayload> => {
      const row = await appendStepToPlanArtifact(params.planId, params.stepText);
      if (!row) throw new Error("Plan artifact not found");
      const payload = toPayload(row);
      broadcastPlanEvent("plan:artifact-updated", payload);
      return payload;
    },
  );

  handle(
    "plans:get",
    async (_event, planId: string): Promise<PlanArtifactPayload | null> => {
      const row = await getPlanArtifact(planId);
      return row ? toPayload(row) : null;
    },
  );

  handle(
    "plans:list-by-session",
    async (_event, sessionId: string): Promise<PlanArtifactPayload[]> => {
      const rows = await listPlanArtifactsForSession(sessionId);
      return rows.map(toPayload);
    },
  );

  handle(
    "plans:set-status",
    async (
      _event,
      params: { planId: string; planStatus: PlanArtifactStatus },
    ): Promise<PlanArtifactPayload> => {
      const row = await setPlanArtifactStatus(params.planId, params.planStatus);
      if (!row) throw new Error("Plan artifact not found");
      const payload = toPayload(row);
      broadcastPlanEvent("plan:artifact-updated", payload);
      return payload;
    },
  );

  ipcMain.on(
    "plan:artifact-activated",
    (event, payload: PlanArtifactPayload) => {
      if (!payload?.planId) return;
      emitPlanArtifactActivated(event.sender, payload);
      broadcastPlanEvent("plan:artifact-activated", payload);
    },
  );

  logger.log("plan artifact handlers registered");
}
