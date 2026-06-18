/**
 * Agent runtime constants — sub-agent caps; permissions always manual.
 */

// Kept at 5 deliberately: this bounds concurrent sub-agent spawns to avoid
// crashing the app / wasting tokens on runaway fan-out. It is a resource guard,
// not a per-task work cap (the agent itself runs unbounded), so it stays.
export const MAX_SUBAGENTS_PER_TURN = 5;

/** Tool permissions always require user approval (former Guided behavior). */
export function shouldAutoApprovePermissions(
  _agentMode?: string | undefined,
  _chatId?: number | null | undefined,
): boolean {
  return false;
}
