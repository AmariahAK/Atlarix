/**
 * Editing + re-sending a previous user message discards every turn after it.
 * This returns the candidate snapshot turn-ids of the discarded ASSISTANT turns,
 * in CHRONOLOGICAL order (the main-process range revert reverses them to
 * newest→oldest). These are the turns whose file changes a "correct" rewind
 * would also undo.
 *
 * A turn's shadow-snapshot is keyed by its `streamTurnId`, which for a normal
 * turn IS the assistant message id. So we fall back to `String(m.id)` when the
 * live `snapshotByMessageId` atom has no entry — crucially, the atom is only
 * populated on a clean `onEnd`, so a STOPPED/cancelled turn (the user hit stop
 * after seeing a bad edit) would otherwise be missed even though its file
 * changes were already captured to disk. The disk read in `snapshot:files-range`
 * is the authority on which candidate ids actually have a snapshot to revert;
 * ids with no manifest contribute nothing and are skipped by the range revert.
 *
 * Pure + side-effect-free so the selection/ordering is unit-testable.
 */
export function discardedTurnSnapshotIds(
  messages: ReadonlyArray<{ id: number; role: string }>,
  editedMessageId: number,
  snapshotByMessageId: ReadonlyMap<number, string>,
): string[] {
  const idx = messages.findIndex(
    (m) => m.id === editedMessageId && m.role === "user",
  );
  if (idx < 0) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    out.push(snapshotByMessageId.get(m.id) ?? String(m.id));
  }
  return out;
}
