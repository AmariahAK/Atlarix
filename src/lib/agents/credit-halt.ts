/**
 * The per-chat "stop delegating, the wallet is empty" latch.
 *
 * WHY A MODULE-LEVEL MAP AND NOT THE TURN CONTEXT. The two places that learn the
 * wallet is empty are in unrelated call stacks. The parent turn learns it in
 * `simple-stream-text`'s `onError`; a sub-agent learns it inside `runSubagent`,
 * several frames below `ToolRegistry.execute("task")` and with no reference to the
 * turn context at all. Threading a setter down through the task tool, the registry
 * and the runner would put a billing concern in four signatures that have no other
 * reason to know about billing. A keyed latch is what `taskStore` already does for
 * the same reason, in the same process.
 *
 * WHY PER CHAT AND NOT PER ROUND. An empty wallet is an ACCOUNT-WIDE condition, not
 * a property of one fan-out, so per-round scoping would be both more machinery and
 * the wrong shape — `taskStore` records carry no round id, so it would mean adding
 * one to get a worse answer. Per chat matches `cancelAllSubagentTasksForChat`, which
 * is the thing the latch has to line up with.
 *
 * WHY IT IS CLEARED AT THE END OF EVERY TURN. The latch stops a round that is
 * already failing; it must not decide the NEXT round, because between two turns the
 * user may have topped up — and the app cannot know whether they did. So each new
 * turn is allowed exactly one real attempt, which either succeeds or re-latches on
 * its own 402. One wasted call per turn is the correct price for not stranding a
 * chat that has been paid for.
 */

/** chatId → the refusal to hand back for further delegations this turn. */
const haltedChats = new Map<number, string>();

/**
 * Latch this chat's delegations off, recording the reason the model will be told.
 *
 * First writer wins. Concurrent siblings all fail within a few hundred milliseconds
 * of each other, and the first refusal is the one that actually described the state
 * the round stopped in; letting a later one overwrite it would only reword the same
 * event, and could replace a message carrying the required amount with one that
 * does not.
 */
export function markCreditExhausted(
  chatId: number | undefined,
  reason: string,
): void {
  if (chatId == null) return;
  if (!haltedChats.has(chatId)) haltedChats.set(chatId, reason);
}

/** The recorded refusal for this chat, or null when delegations are still allowed. */
export function creditHaltReason(chatId: number | undefined): string | null {
  if (chatId == null) return null;
  return haltedChats.get(chatId) ?? null;
}

/** Clear the latch — called once per turn from `finalize`. */
export function clearCreditHalt(chatId: number | undefined): void {
  if (chatId == null) return;
  haltedChats.delete(chatId);
}

/** Test seam only: forget every latch. */
export function __resetCreditHaltsForTests(): void {
  haltedChats.clear();
}
