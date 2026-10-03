import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { chatSessions, sessionMessages } from "@/db/schema";
import type { PlanArtifactStatus } from "@/db/schema";
import { eq, desc, and, ne } from "drizzle-orm";

export type PlanArtifactRow = {
  id: string;
  sessionId: string;
  content: string;
  planStatus: PlanArtifactStatus;
  /**
   * The plan's name as the model supplied it. `null` for rows written before the
   * title column existed — those still fall back to scraping the markdown
   * (`planArtifactTitleFromContent`), which is the only thing that fallback is
   * for now.
   */
  title: string | null;
  createdAt: Date;
};

function mapRow(row: typeof sessionMessages.$inferSelect): PlanArtifactRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    content: row.content,
    planStatus: (row.planStatus ?? "plan") as PlanArtifactStatus,
    title: row.title ?? null,
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
  // The title is STORED, not spliced into the markdown.
  //
  // This used to prepend `# ${title}` to the body, but only when the body did
  // not already start with `#` — a guard that could not tell a real H1 title
  // from a `## Goal` section heading, so it silently dropped the title for every
  // model that structured its plan with headings. Readers then scraped the first
  // line back out and displayed "Goal" as the plan's name. Keeping the title as
  // its own column removes both halves of that round trip.
  const [row] = await db
    .insert(sessionMessages)
    .values({
      id,
      sessionId,
      role: "assistant",
      content: content.trim(),
      kind: "plan",
      planStatus: "plan",
      title: title?.trim() || null,
      createdAt: now,
    })
    .returning();
  return mapRow(row);
}

/**
 * Per-plan write serialiser.
 *
 * THE BUG THIS EXISTS FOR (observed live, 2026-08-19/20):
 * every plan mutation is read-whole-document -> transform in JS -> write whole
 * document, and `updatePlanArtifactContent` is a blind `SET content = ?` with no
 * version check. A model can emit several `update_step` calls in ONE step, so
 * three arrived concurrently, all read the SAME snapshot, each flipped its own
 * step, and each wrote the full body. Last write won: two updates were lost, and
 * the steps came back not merely unticked but reverted to `todo`, because the
 * winning snapshot predated their `in_progress` marks too. Each call cheerfully
 * reported "1/6 steps done" — all three computing 0 + 1 from the same base.
 *
 * That is a lost-update race, and it is why marking several steps "went one by
 * one": only the last one survived.
 *
 * A FIFO chain rather than `withLock` from ipc/utils: that helper awaits only the
 * ONE lock it observed, so with three contenders B and C both wake when A
 * releases and both acquire — it serialises two callers, not N. (Its existing
 * app-lifecycle callers are a separate question; see docs/TODO.md.)
 *
 * Correctness depends on the caller re-reading the row INSIDE the callback. The
 * lock alone does not help a transform that closed over a stale snapshot.
 */
const planWriteQueue = new Map<string, Promise<unknown>>();

export function withPlanArtifactLock<T>(
  planId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = planWriteQueue.get(planId) ?? Promise.resolve();
  // `.then(fn, fn)` so one caller's rejection cannot strand the queue.
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  planWriteQueue.set(planId, tail);
  void tail.then(() => {
    // Drop the key once this is the last writer, so the map cannot grow forever.
    if (planWriteQueue.get(planId) === tail) planWriteQueue.delete(planId);
  });
  return run;
}

export async function updatePlanArtifactContent(
  planId: string,
  content: string,
): Promise<PlanArtifactRow | null> {
  const [row] = await db
    .update(sessionMessages)
    .set({ content: content.trim() })
    .where(
      and(eq(sessionMessages.id, planId), eq(sessionMessages.kind, "plan")),
    )
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Append a single checklist step to a plan without rewriting the whole body.
 * Lets the user (and the agent) add items mid-flight without a lossy full
 * overwrite. Returns null if the plan no longer exists.
 */
export async function appendStepToPlanArtifact(
  planId: string,
  stepText: string,
): Promise<PlanArtifactRow | null> {
  // Read INSIDE the lock: appending to a body fetched before the lock would drop
  // whatever a concurrent update_step had just written.
  return withPlanArtifactLock(planId, async () => {
    const existing = await getPlanArtifact(planId);
    if (!existing) return null;
    const clean = stepText
      .trim()
      .replace(/^[-*+]\s*/, "") // strip a leading bullet if the caller added one
      .replace(/^\[[ x~!]?\]\s*/i, ""); // strip a leading checkbox too
    if (!clean) return existing;
    const content = `${existing.content.trimEnd()}\n- [ ] ${clean}\n`;
    return updatePlanArtifactContent(planId, content);
  });
}

export async function setPlanArtifactStatus(
  planId: string,
  planStatus: PlanArtifactStatus,
): Promise<PlanArtifactRow | null> {
  const [row] = await db
    .update(sessionMessages)
    .set({ planStatus })
    .where(
      and(eq(sessionMessages.id, planId), eq(sessionMessages.kind, "plan")),
    )
    .returning();
  return row ? mapRow(row) : null;
}

export async function getPlanArtifact(
  planId: string,
): Promise<PlanArtifactRow | null> {
  const row = await db.query.sessionMessages.findFirst({
    where: and(
      eq(sessionMessages.id, planId),
      eq(sessionMessages.kind, "plan"),
    ),
  });
  return row ? mapRow(row) : null;
}

export async function listPlanArtifactsForSession(
  sessionId: string,
): Promise<PlanArtifactRow[]> {
  const rows = await db
    .select()
    .from(sessionMessages)
    .where(
      and(
        eq(sessionMessages.sessionId, sessionId),
        eq(sessionMessages.kind, "plan"),
      ),
    )
    .orderBy(desc(sessionMessages.createdAt));
  return rows.map(mapRow);
}

/** A plan from another session in the same folder, with that session's name. */
export type WorkspacePlanRow = PlanArtifactRow & { sessionTitle: string | null };

/**
 * Every plan in a folder's sessions, newest first — so a plan written in an
 * earlier session (closed, or in the other app) can be read and built again.
 * The CLI's /plan and the desktop's Plan panel both list these under "Earlier
 * sessions".
 */
export async function listPlanArtifactsForWorkspace(
  workspaceId: number,
  opts: { excludeSessionId?: string; limit?: number } = {},
): Promise<WorkspacePlanRow[]> {
  const rows = await db
    .select({ plan: sessionMessages, sessionTitle: chatSessions.title })
    .from(sessionMessages)
    .innerJoin(chatSessions, eq(sessionMessages.sessionId, chatSessions.id))
    .where(
      and(
        eq(chatSessions.workspaceId, workspaceId),
        eq(sessionMessages.kind, "plan"),
        ...(opts.excludeSessionId ? [ne(sessionMessages.sessionId, opts.excludeSessionId)] : []),
      ),
    )
    .orderBy(desc(sessionMessages.createdAt))
    .limit(opts.limit ?? 50);
  return rows.map((r) => ({ ...mapRow(r.plan), sessionTitle: r.sessionTitle ?? null }));
}

/**
 * Bring a plan from an earlier session into this one, to build it here. A copy:
 * the original keeps its own status and history.
 */
export async function copyPlanArtifactToSession(
  planId: string,
  sessionId: string,
): Promise<PlanArtifactRow | null> {
  const source = await getPlanArtifact(planId);
  if (!source) return null;
  return createPlanArtifact(sessionId, source.content, source.title ?? undefined);
}

/**
 * The newest plan for a session, optionally restricted to one status.
 *
 * `status` is a REAL FILTER: no match returns null.
 *
 * It used to end `?? rows[0] ?? null`, so passing a status only expressed a
 * preference — every caller got the newest plan regardless. Three call sites
 * already wrote `?? getLatestPlanArtifact(sessionId)` after it, which is only
 * meaningful if the first call can return null; their authors clearly believed
 * it filtered, and for them nothing changes.
 *
 * The site that was silently relying on the fallback is the turn-end safety net
 * (`chat_stream/turn-runner/finalize.ts`). It asks for the plan that is
 * *building*, and used to get the newest plan whatever its status — then ticked
 * every step and marked it `built`. A plan the model had just written and not
 * started could be stamped 100% complete, which is how a fabricated "18/18"
 * reaches the card.
 */
export async function getLatestPlanArtifact(
  sessionId: string,
  status?: PlanArtifactStatus,
): Promise<PlanArtifactRow | null> {
  const rows = await listPlanArtifactsForSession(sessionId);
  if (status) {
    return rows.find((r) => r.planStatus === status) ?? null;
  }
  return rows[0] ?? null;
}

export function planArtifactMarker(planId: string): string {
  return `<!-- atlarix-plan-artifact:${planId} -->`;
}

/** Ensure inline plan cards render even when the model omits the marker comment. */
export function ensurePlanMarkersInAssistantContent(content: string): string {
  let out = content;
  const re = /"planId"\s*:\s*"([0-9a-f-]{36})"/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const planId = m[1]!;
    if (seen.has(planId)) continue;
    seen.add(planId);
    const marker = planArtifactMarker(planId);
    if (!out.includes(marker)) {
      out = `${out.trimEnd()}\n\n${marker}\n`;
    }
  }
  return out;
}
