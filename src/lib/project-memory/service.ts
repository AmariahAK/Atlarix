/**
 * SQLite project memory (snapshots + key/value).
 *
 * Pass 7: Blueprint subsystem removed — snapshots no longer carry
 * blueprintJson. Plan markdown + git commit hash + session summary remain.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { db } from "@/db";
import { apps, projectMemory, projectSnapshots } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getAtlarixAppPath } from "@/paths/paths";
import { getCurrentCommitHash } from "@/ipc/utils/git_utils";
const PLAN_FILE = ".atlarix/ATLARIX_PLAN.md";
import log from "electron-log";

const logger = log.scope("project-memory");

export type ProjectSnapshotTrigger =
  | "blueprint_change"
  | "plan_update"
  | "build_complete"
  | "session_end";

const MAX_SNAPSHOTS_PER_WORKSPACE = 100;
const touchedWorkspaces = new Set<number>();
// PASS6: Blueprint subsystem restored — debounce per workspace blueprint writes.
const blueprintDebounce = new Map<number, ReturnType<typeof setTimeout>>();
/** Coalesce burst plan writes (e.g. duplicate permission ops) into one snapshot per workspace. */
const planUpdateSnapshotDebounce = new Map<number, ReturnType<typeof setTimeout>>();
const PLAN_UPDATE_SNAPSHOT_DEBOUNCE_MS = 400;

function markTouched(workspaceId: number): void {
  touchedWorkspaces.add(workspaceId);
}

async function readPlanMd(workspacePath: string): Promise<string | null> {
  const fp = path.join(workspacePath, PLAN_FILE);
  try {
    return await fs.readFile(fp, "utf-8");
  } catch {
    return null;
  }
}

async function gatherPayload(workspacePath: string): Promise<{
  planMd: string | null;
  gitCommitHash: string | null;
}> {
  const planMd = await readPlanMd(workspacePath);
  let gitCommitHash: string | null = null;
  try {
    gitCommitHash = (await getCurrentCommitHash({ path: workspacePath })) ?? null;
  } catch {
    gitCommitHash = null;
  }
  return { planMd, gitCommitHash };
}

async function pruneSnapshots(workspaceId: number): Promise<void> {
  const rows = await db
    .select({ id: projectSnapshots.id })
    .from(projectSnapshots)
    .where(eq(projectSnapshots.workspaceId, workspaceId))
    .orderBy(desc(projectSnapshots.createdAt));
  if (rows.length <= MAX_SNAPSHOTS_PER_WORKSPACE) return;
  const drop = rows.slice(MAX_SNAPSHOTS_PER_WORKSPACE).map((r) => r.id);
  if (drop.length === 0) return;
  await db.delete(projectSnapshots).where(inArray(projectSnapshots.id, drop));
}

export async function insertProjectSnapshot(params: {
  workspaceId: number;
  workspacePath: string;
  trigger: ProjectSnapshotTrigger;
  sessionSummary?: string | null;
  blueprintJson?: string;
}): Promise<void> {
  const { workspaceId, workspacePath, trigger, sessionSummary, blueprintJson } = params;
  markTouched(workspaceId);
  try {
    const payload = await gatherPayload(workspacePath);
    await db.insert(projectSnapshots).values({
      workspaceId,
      // PASS6: Blueprint subsystem restored; column is required. Use the
      // provided blueprintJson (blueprint_change snapshots) or an empty graph
      // placeholder for other triggers when no Blueprint exists yet.
      blueprintJson: blueprintJson ?? "{}",
      planMd: payload.planMd,
      gitCommitHash: payload.gitCommitHash,
      sessionSummary: sessionSummary ?? null,
      trigger,
    });
    await pruneSnapshots(workspaceId);
    logger.debug("insertProjectSnapshot", { workspaceId, trigger });
  } catch (e) {
    logger.warn("insertProjectSnapshot failed:", e);
  }
}

/**
 * PASS6: Debounced blueprint-change snapshot writer used by Blueprint IPC handlers.
 */
export function scheduleBlueprintChangeSnapshot(
  workspaceId: number,
  workspacePath: string,
  blueprintJson: string,
): void {
  markTouched(workspaceId);
  const prev = blueprintDebounce.get(workspaceId);
  if (prev) clearTimeout(prev);
  blueprintDebounce.set(
    workspaceId,
    setTimeout(() => {
      blueprintDebounce.delete(workspaceId);
      void insertProjectSnapshot({
        workspaceId,
        workspacePath,
        trigger: "blueprint_change",
        blueprintJson,
      });
    }, 1500),
  );
}

export async function recordPlanUpdateSnapshot(workspaceId: number, workspacePath: string): Promise<void> {
  const prev = planUpdateSnapshotDebounce.get(workspaceId);
  if (prev) clearTimeout(prev);
  planUpdateSnapshotDebounce.set(
    workspaceId,
    setTimeout(() => {
      planUpdateSnapshotDebounce.delete(workspaceId);
      void insertProjectSnapshot({ workspaceId, workspacePath, trigger: "plan_update" });
    }, PLAN_UPDATE_SNAPSHOT_DEBOUNCE_MS),
  );
}

export async function recordBuildCompleteSnapshot(
  workspaceId: number,
  workspacePath: string,
  sessionSummary?: string,
): Promise<void> {
  await insertProjectSnapshot({
    workspaceId,
    workspacePath,
    trigger: "build_complete",
    sessionSummary: sessionSummary ?? null,
  });
}

export async function flushSessionEndSnapshots(): Promise<void> {
  const ids = [...touchedWorkspaces];
  touchedWorkspaces.clear();
  for (const workspaceId of ids) {
    const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
    if (!app) continue;
    const workspacePath = getAtlarixAppPath(app.path);
    await insertProjectSnapshot({
      workspaceId,
      workspacePath,
      trigger: "session_end",
    });
  }
}

export async function listProjectSnapshots(
  workspaceId: number,
  limit = 30,
): Promise<
  Array<{
    id: number;
    createdAt: Date;
    trigger: string;
    sessionSummary: string | null;
    planExcerpt: string | null;
  }>
> {
  const rows = await db
    .select({
      id: projectSnapshots.id,
      createdAt: projectSnapshots.createdAt,
      trigger: projectSnapshots.trigger,
      sessionSummary: projectSnapshots.sessionSummary,
      planMd: projectSnapshots.planMd,
    })
    .from(projectSnapshots)
    .where(eq(projectSnapshots.workspaceId, workspaceId))
    .orderBy(desc(projectSnapshots.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt as Date,
    trigger: r.trigger,
    sessionSummary: r.sessionSummary,
    planExcerpt: r.planMd ? r.planMd.slice(0, 400) : null,
  }));
}

export async function getProjectSnapshotRow(
  snapshotId: number,
  workspaceId: number,
): Promise<{ planMd: string | null } | null> {
  const [row] = await db
    .select({
      planMd: projectSnapshots.planMd,
      workspaceId: projectSnapshots.workspaceId,
    })
    .from(projectSnapshots)
    .where(and(eq(projectSnapshots.id, snapshotId), eq(projectSnapshots.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;
  return { planMd: row.planMd };
}

export async function applyProjectSnapshotRevert(
  workspaceId: number,
  workspacePath: string,
  snapshotId: number,
): Promise<{ success: boolean; error?: string }> {
  const row = await getProjectSnapshotRow(snapshotId, workspaceId);
  if (!row) return { success: false, error: "Snapshot not found for this workspace" };
  try {
    if (row.planMd != null) {
      await fs.mkdir(path.join(workspacePath, ".atlarix"), { recursive: true });
      await fs.writeFile(path.join(workspacePath, PLAN_FILE), row.planMd, "utf-8");
    }
    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function listProjectMemoryKeys(workspaceId: number): Promise<Array<{ key: string; value: string }>> {
  return db
    .select({ key: projectMemory.key, value: projectMemory.value })
    .from(projectMemory)
    .where(eq(projectMemory.workspaceId, workspaceId));
}

export async function upsertProjectMemoryKey(
  workspaceId: number,
  key: string,
  value: string,
): Promise<void> {
  markTouched(workspaceId);
  const k = key.slice(0, 256);
  const v = value.slice(0, 16_000);
  await db.delete(projectMemory).where(and(eq(projectMemory.workspaceId, workspaceId), eq(projectMemory.key, k)));
  await db.insert(projectMemory).values({
    workspaceId,
    key: k,
    value: v,
    updatedAt: sql`(unixepoch())`,
  });
}

// v11.1: buildProjectMemoryPromptBlock deleted — prompt pre-injection was
// removed (PASS5); the model reads memory via the get_project_memory tool.
