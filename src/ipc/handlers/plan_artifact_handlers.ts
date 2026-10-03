import { ipcMain, BrowserWindow } from "electron";
import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import {
  getPlanArtifact,
  listPlanArtifactsForSession,
  listPlanArtifactsForWorkspace,
  copyPlanArtifactToSession,
  setPlanArtifactStatus,
  updatePlanArtifactContent,
  withPlanArtifactLock,
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
    title: row.title,
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
    "plans:update",
    async (
      _event,
      params: { planId: string; content: string },
    ): Promise<PlanArtifactPayload> => {
      // Serialised against the agent's own writes. The user editing the plan
      // while a turn marks steps is a genuine two-writer case; whoever is second
      // should land after the first, not on top of a stale body.
      const row = await withPlanArtifactLock(params.planId, () =>
        updatePlanArtifactContent(params.planId, params.content),
      );
      if (!row) throw new Error("Plan artifact not found");
      const payload = toPayload(row);
      broadcastPlanEvent("plan:artifact-updated", payload);
      return payload;
    },
  );

  // Every plan in a session, newest first, for the panel's switcher. The panel
  // used to render only getLatestPlanArtifact's first row with nothing naming
  // which plan it was, so a session with three plans presented one as though it
  // were THE plan.
  handle(
    "plans:list-by-session",
    async (_event, sessionId: string): Promise<PlanArtifactPayload[]> => {
      if (!sessionId?.trim()) return [];
      const rows = await listPlanArtifactsForSession(sessionId);
      return rows.map(toPayload);
    },
  );

  // Plans from this folder's OTHER sessions ("Earlier sessions" in the panel's
  // switcher): a plan outlives the session it was written in.
  handle(
    "plans:list-by-workspace",
    async (
      _event,
      params: { workspaceId: number; excludeSessionId?: string },
    ): Promise<Array<PlanArtifactPayload & { sessionTitle: string | null }>> => {
      if (!params?.workspaceId) return [];
      const rows = await listPlanArtifactsForWorkspace(params.workspaceId, {
        excludeSessionId: params.excludeSessionId,
      });
      return rows.map((r) => ({ ...toPayload(r), sessionTitle: r.sessionTitle }));
    },
  );

  // "Use in this session": copy an earlier session's plan here to build it.
  handle(
    "plans:copy-to-session",
    async (
      _event,
      params: { planId: string; sessionId: string },
    ): Promise<PlanArtifactPayload> => {
      const row = await copyPlanArtifactToSession(params.planId, params.sessionId);
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
