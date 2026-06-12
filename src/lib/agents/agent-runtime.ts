/**
 * Agent runtime constants — sub-agent caps; permissions always manual.
 */

export const MAX_SUBAGENTS_PER_TURN = 5;

/** Tool permissions always require user approval (former Guided behavior). */
export function shouldAutoApprovePermissions(
  _agentMode?: string | undefined,
  _chatId?: number | null | undefined,
): boolean {
  return false;
}
