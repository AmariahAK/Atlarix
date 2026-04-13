/**
 * Tracks tool names executed per stream turn (assistant message id) for auto-memory and telemetry.
 * Cleared after auto-memory runs for that turn (see maybeAppendAutoMemoryAfterStream).
 */

const toolsUsedByTurnId = new Map<string, string[]>();

export function recordToolUseForTurn(turnId: string, toolName: string): void {
  const arr = toolsUsedByTurnId.get(turnId) ?? [];
  if (!arr.includes(toolName)) {
    arr.push(toolName);
    toolsUsedByTurnId.set(turnId, arr);
  }
}

export function getToolsUsedThisTurn(turnId: string): string[] {
  return [...(toolsUsedByTurnId.get(turnId) ?? [])];
}

export function clearToolsUsedForTurn(turnId: string): void {
  toolsUsedByTurnId.delete(turnId);
}
