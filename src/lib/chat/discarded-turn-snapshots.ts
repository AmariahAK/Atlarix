/**
 * Editing + re-sending a previous user message discards every turn after it.
 * This returns the `snapshotTurnId`s of the discarded ASSISTANT turns that
 * captured a workspace snapshot, in CHRONOLOGICAL order (the main-process range
 * revert reverses them to newest→oldest). These are the turns whose file
 * changes a "correct" rewind would also undo.
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
    const turnId = snapshotByMessageId.get(m.id);
    if (turnId) out.push(turnId);
  }
  return out;
}
