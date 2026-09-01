/**
 * What makes a message the durable compaction marker — and nothing else.
 *
 * A LEAF ON PURPOSE. `lib/context/compaction.ts` pulls in the `ai` SDK, settings,
 * the model client and the keychain chain; the RENDERER needs this predicate too
 * (to keep the marker out of the visible thread), and importing the compactor
 * into a `.tsx` would drag all of that into the browser bundle. Same reasoning as
 * `mid-loop-threshold.ts`. `compaction.ts` re-exports these, so there is still
 * exactly one definition.
 */

/**
 * v11.1 durable compaction: summary messages carry this prefix.
 *
 * Kept as a FALLBACK identifier only. Rows written before v14.39.1 have no
 * `kind`, so text is all they have; anything written since is identified by its
 * column, because text is forgeable — `flattenNativeForCompaction` renders tool
 * results as `{ role: "user", content: "<tool_result …>" }`, so any output
 * beginning with these bytes used to be indistinguishable from a real marker.
 */
export const COMPACTION_SUMMARY_PREFIX = "[COMPACTION MARKER]";

/** The `session_messages.kind` that marks a durable summary row. */
export const COMPACTION_MARKER_KIND = "compaction_marker";

/** Anything the detector can be asked about: a live message or a loaded row. */
export type MarkerCandidate = { content?: string | null; kind?: string | null };

/**
 * Is this row the durable compaction summary? Structure first, text as the
 * legacy fallback. See `sliceFromLastCompactionSummary` for the rule that stops
 * the fallback applying once a list holds a genuinely flagged marker.
 */
export function isCompactionSummaryMessage(
  candidate: MarkerCandidate | string | null | undefined,
): boolean {
  if (typeof candidate === "string" || candidate == null) {
    return (
      typeof candidate === "string" &&
      candidate.startsWith(COMPACTION_SUMMARY_PREFIX)
    );
  }
  if (candidate.kind === COMPACTION_MARKER_KIND) return true;
  return (
    typeof candidate.content === "string" &&
    candidate.content.startsWith(COMPACTION_SUMMARY_PREFIX)
  );
}
