/**
 * Whether permissioned tool execution should run without blocking on the user queue.
 * Autonomous mode + valid chat session only; does not change which tools exist (Ask/Build gates unchanged).
 */
export function shouldAutoApprovePermissions(
  agentMode: string | undefined,
  chatId: number | null | undefined,
): boolean {
  return agentMode === "autonomous" && chatId != null && Number.isFinite(chatId);
}
