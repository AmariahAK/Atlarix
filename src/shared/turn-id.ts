/**
 * A turn's id: its assistant message's transport id, then the process that ran
 * it. Message ids are seeded from the clock in every process, so two Atlarix
 * processes starting a turn in the same millisecond got the same id, and in one
 * folder the second turn's /undo snapshot replaced the first's (audit 1f). The
 * pid keeps them apart; the leading number still names the message.
 */
export function turnIdForMessage(messageId: number, pid: number): string {
  return `${messageId}-${pid}`;
}

/** The assistant message a turn id names; also reads ids from before the pid was added. */
export function messageIdOfTurn(turnId: string | null | undefined): number | null {
  const m = /^(\d+)(?:-\d+)?$/.exec(String(turnId ?? ""));
  return m ? Number(m[1]) : null;
}
