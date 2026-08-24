/**
 * Edit stats — how much the agent has written, per workspace and per model.
 *
 * WHAT THIS COUNTS, AND WHAT IT DOES NOT
 * Accepted writes through the file tools, and only those. The agent also changes
 * files by running commands — `sed -i`, a codegen script, a formatter, `npm install`
 * — and commands auto-run in Build and Debug, so those changes never pass a write
 * gate and are not counted here. That is a deliberate, stated limit rather than an
 * oversight: the UI says so, because a number labelled "lines changed" that silently
 * misses a third of them is worse than a smaller number that means what it says.
 *
 * Counts are GROSS. Reverting a turn does not subtract, matching how every editor
 * that shows this number behaves — it measures work done, not net lines surviving.
 */

import log from "electron-log";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { editStats } from "@/db/schema";
import { computeDiffHunks } from "@/lib/diff/compose-hunks";
import {
  COMPASS_PROVIDER_ID,
  getCoreModelIdForCoreTier,
} from "@/ipc/shared/compass_constants";
import type { LargeLanguageModel } from "@/lib/schemas";

const logger = log.scope("edit-stats");

export type EditStatsOperationType = "create" | "update" | "delete" | "rename";

export interface LineDelta {
  added: number;
  removed: number;
}

/**
 * Lines added/removed by one accepted write.
 *
 * Uses the SAME LCS hunks the per-hunk approval UI computes
 * (`computeDiffHunks`), so the recorded numbers are the ones the user saw on the
 * approval card. Deriving them any other way — counting lines of the new file, or
 * trusting the tool's own reported figure — would drift from the diff on screen,
 * and a stat that disagrees with the thing it claims to summarise is worthless.
 */
export function computeLineDelta(
  type: EditStatsOperationType,
  oldContent: string | undefined,
  newContent: string | undefined,
): LineDelta {
  // A rename moves bytes without changing them. Counting the file twice — once as
  // removed at the old path, once as added at the new — would make a tidy-up look
  // like the biggest day of work in the project.
  if (type === "rename") return { added: 0, removed: 0 };

  if (type === "delete") {
    return { added: 0, removed: countLines(oldContent) };
  }
  if (type === "create" || !oldContent) {
    return { added: countLines(newContent), removed: 0 };
  }

  let added = 0;
  let removed = 0;
  for (const hunk of computeDiffHunks(oldContent, newContent ?? "")) {
    added += hunk.addedCount;
    removed += hunk.removedCount;
  }
  return { added, removed };
}

function countLines(content: string | undefined): number {
  if (!content) return 0;
  const withoutTrailingNewline = content.endsWith("\n")
    ? content.slice(0, -1)
    : content;
  if (withoutTrailingNewline === "") return 0;
  return withoutTrailingNewline.split("\n").length;
}

/**
 * The LOCAL calendar day, `YYYY-MM-DD`.
 *
 * `toISOString()` would be UTC, which quietly files an evening's work under
 * tomorrow for anyone east of Greenwich and under today for anyone west — on a
 * column whose entire purpose is to be shown to a person as "today".
 */
export function localDayKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface RecordEditStatsArgs {
  workspaceId: number;
  /** As dispatched: `compass` for Atlarix Core, else the vendor id. */
  provider: string;
  /** Already resolved — never a `core-N` tier id. See the schema comment. */
  modelId: string;
  delta: LineDelta;
  now?: Date;
}

/**
 * Accumulate one accepted write into today's bucket.
 *
 * An UPSERT on the unique bucket rather than read-modify-write: two windows can be
 * writing to the same workspace at the same moment, and a read-then-update would
 * drop one of their counts with no sign that it had.
 */
export async function recordEditStats({
  workspaceId,
  provider,
  modelId,
  delta,
  now,
}: RecordEditStatsArgs): Promise<void> {
  if (!provider || !modelId) return;
  // A write that changed nothing (a no-op edit, a rename) still happened, but
  // recording a zero row would put a model in the "used" list for having touched
  // nothing. Only count operations that moved a line.
  if (delta.added <= 0 && delta.removed <= 0) return;

  await db
    .insert(editStats)
    .values({
      workspaceId,
      day: localDayKey(now),
      provider,
      modelId,
      linesAdded: delta.added,
      linesRemoved: delta.removed,
      edits: 1,
    })
    .onConflictDoUpdate({
      target: [
        editStats.workspaceId,
        editStats.day,
        editStats.provider,
        editStats.modelId,
      ],
      set: {
        linesAdded: sql`${editStats.linesAdded} + ${delta.added}`,
        linesRemoved: sql`${editStats.linesRemoved} + ${delta.removed}`,
        edits: sql`${editStats.edits} + 1`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Fire-and-forget wrapper for the write path.
 *
 * Statistics must never be able to fail a turn — an edit the user approved has
 * already landed on disk by the time we get here, so a failure to count it is a
 * cosmetic loss and nothing more.
 */
export function recordEditStatsSafely(args: RecordEditStatsArgs): void {
  void recordEditStats(args).catch((e) => {
    logger.warn("failed to record edit stats", e);
  });
}

/**
 * How a turn's model should be recorded.
 *
 * ATTRIBUTED TO WHAT DISPATCHED, NOT TO WHAT WAS SELECTED. `dispatched` comes from
 * the model client that actually served the turn, and it is preferred whenever it is
 * available because the two can differ: when the selected provider has no usable API
 * key, `getModelClient` falls back to Atlarix Core and rewrites the model INTERNALLY,
 * leaving `effectiveModel` still naming the user's original choice. Reading the
 * selection there would credit BYOK DeepSeek for work Atlarix Core did — which is
 * exactly the distinction this card exists to draw, so getting it wrong there is
 * worse than not drawing it at all.
 *
 * Two rules survive from the selection path, and both are about staying true later:
 *
 *  - Core stores the RESOLVED model, never `core-3`. A tier id is a pointer, and
 *    repointing it would silently rewrite history — last month's DeepSeek lines
 *    would start claiming to be whatever model took the slot. Resolving at write
 *    time also means adding a model to Core needs no code change here: the answer
 *    comes from `core-models.json`.
 *  - The provider stays `compass` rather than the vendor underneath. It is the only
 *    thing separating "DeepSeek V4 Pro through Atlarix Core" from "DeepSeek V4 Pro
 *    on your own key" — the same model, reached two ways.
 *
 * Must run in MAIN: the tier→model map lives in main-process module state.
 */
export function resolveEditStatsModel(
  effectiveModel: LargeLanguageModel | undefined | null,
  /** The client that actually served the turn — `builtinProviderId` + wire model id. */
  dispatched?: { providerId?: string; modelId?: string } | null,
): { provider: string; name: string } | null {
  const dispatchedProvider = dispatched?.providerId?.trim();
  const dispatchedModel = dispatched?.modelId?.trim();
  if (dispatchedProvider && dispatchedModel) {
    return { provider: dispatchedProvider, name: dispatchedModel };
  }

  const provider = effectiveModel?.provider?.trim();
  const name = effectiveModel?.name?.trim();
  if (!provider || !name) return null;
  if (provider !== COMPASS_PROVIDER_ID) return { provider, name };
  return {
    provider,
    // An unmapped tier falls back to its own id rather than dropping the row: a
    // number that is slightly coarse beats a silently missing one.
    name: getCoreModelIdForCoreTier(name) ?? name,
  };
}

/**
 * Read the dispatched identity off a model client.
 *
 * `model.modelId` is the wire id the provider was actually called with — for Core
 * that is already the `vendor/model` form, so it needs no tier resolution and cannot
 * go stale when the lineup moves.
 */
export function dispatchedModelIdentity(modelClient: {
  builtinProviderId?: string;
  model?: unknown;
}): { providerId?: string; modelId?: string } {
  const modelId =
    modelClient.model && typeof modelClient.model === "object"
      ? (modelClient.model as { modelId?: unknown }).modelId
      : undefined;
  return {
    providerId: modelClient.builtinProviderId,
    modelId: typeof modelId === "string" ? modelId : undefined,
  };
}
