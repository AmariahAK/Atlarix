/**
 * Lightning review memory: SQLite review_patterns — learn from past fixes per workspace.
 * Before LLM review, check if pattern was seen; if accepted fix exists, suggest directly.
 */

import { db } from "@/db";
import { reviewPatterns } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export interface StoredPattern {
  id: number;
  workspaceId: number;
  issueRule: string;
  issueContext: string | null;
  fixApplied: string;
  accepted: boolean;
  createdAt: Date;
}

/**
 * Find a known pattern for this rule + context; return suggested fix if accepted.
 */
export async function getKnownFix(
  workspaceId: number,
  issueRule: string,
  issueContext?: string
): Promise<{ fixApplied: string } | null> {
  const rows = await db
    .select()
    .from(reviewPatterns)
    .where(
      and(
        eq(reviewPatterns.workspaceId, workspaceId),
        eq(reviewPatterns.issueRule, issueRule),
        eq(reviewPatterns.accepted, true)
      )
    )
    .orderBy(reviewPatterns.createdAt)
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0];
  if (issueContext != null && r.issueContext != null && r.issueContext !== issueContext) return null;
  return { fixApplied: r.fixApplied };
}

/**
 * Record a pattern after review+fix cycle.
 */
export async function recordPattern(params: {
  workspaceId: number;
  issueRule: string;
  issueContext?: string;
  fixApplied: string;
  accepted?: boolean;
}): Promise<void> {
  await db.insert(reviewPatterns).values({
    workspaceId: params.workspaceId,
    issueRule: params.issueRule,
    issueContext: params.issueContext ?? null,
    fixApplied: params.fixApplied,
    accepted: params.accepted ?? true,
  });
}
