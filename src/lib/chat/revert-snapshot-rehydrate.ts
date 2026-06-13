/**
 * Rebuild the message-id → shadow-git `snapshotTurnId` map from persisted session
 * rows when a chat is reloaded, so the revert-turn affordance survives a restart.
 *
 * Persisted rows carry `snapshotTurnId` (assistant turns only); the loaded UI
 * messages carry their persisted `sessionRowId` + a renderer `id`. We key the
 * map by the UI message id (what RevertTurnAction looks up).
 */
export function buildRevertSnapshotMap(
  rows: Array<{ id: string; role: string; snapshotTurnId?: string | null }>,
  uiMessages: Array<{ id: number; sessionRowId?: string }>,
): Map<number, string> {
  const byRow = new Map<string, string>();
  for (const r of rows) {
    if (r.role === "assistant" && r.snapshotTurnId) {
      byRow.set(r.id, r.snapshotTurnId);
    }
  }
  const out = new Map<number, string>();
  for (const um of uiMessages) {
    const sid = um.sessionRowId ? byRow.get(um.sessionRowId) : undefined;
    if (sid) out.set(um.id, sid);
  }
  return out;
}
