import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { sessionMessages } from "@/db/schema";
import type { PlanArtifactStatus } from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";

export type PlanArtifactRow = {
  id: string;
  sessionId: string;
  content: string;
  planStatus: PlanArtifactStatus;
  createdAt: Date;
};

function mapRow(row: typeof sessionMessages.$inferSelect): PlanArtifactRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    content: row.content,
    planStatus: (row.planStatus ?? "plan") as PlanArtifactStatus,
    createdAt: row.createdAt,
  };
}

export async function createPlanArtifact(
  sessionId: string,
  content: string,
  title?: string,
): Promise<PlanArtifactRow> {
  const id = randomUUID();
  const now = new Date();
  const body =
    title && !content.trim().startsWith("#")
      ? `# ${title.trim()}\n\n${content.trim()}`
      : content.trim();
  const [row] = await db
    .insert(sessionMessages)
    .values({
      id,
      sessionId,
      role: "assistant",
      content: body,
      kind: "plan",
      planStatus: "plan",
      createdAt: now,
    })
    .returning();
  return mapRow(row);
}

export async function updatePlanArtifactContent(
  planId: string,
  content: string,
): Promise<PlanArtifactRow | null> {
  const [row] = await db
    .update(sessionMessages)
    .set({ content: content.trim() })
    .where(and(eq(sessionMessages.id, planId), eq(sessionMessages.kind, "plan")))
    .returning();
  return row ? mapRow(row) : null;
}

export async function setPlanArtifactStatus(
  planId: string,
  planStatus: PlanArtifactStatus,
): Promise<PlanArtifactRow | null> {
  const [row] = await db
    .update(sessionMessages)
    .set({ planStatus })
    .where(and(eq(sessionMessages.id, planId), eq(sessionMessages.kind, "plan")))
    .returning();
  return row ? mapRow(row) : null;
}

export async function getPlanArtifact(planId: string): Promise<PlanArtifactRow | null> {
  const row = await db.query.sessionMessages.findFirst({
    where: and(eq(sessionMessages.id, planId), eq(sessionMessages.kind, "plan")),
  });
  return row ? mapRow(row) : null;
}

export async function listPlanArtifactsForSession(
  sessionId: string,
): Promise<PlanArtifactRow[]> {
  const rows = await db
    .select()
    .from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.kind, "plan")))
    .orderBy(desc(sessionMessages.createdAt));
  return rows.map(mapRow);
}

export async function getLatestPlanArtifact(
  sessionId: string,
  status?: PlanArtifactStatus,
): Promise<PlanArtifactRow | null> {
  const rows = await listPlanArtifactsForSession(sessionId);
  if (status) {
    return rows.find((r) => r.planStatus === status) ?? rows[0] ?? null;
  }
  return rows[0] ?? null;
}

export function planArtifactMarker(planId: string): string {
  return `<!-- atlarix-plan-artifact:${planId} -->`;
}
