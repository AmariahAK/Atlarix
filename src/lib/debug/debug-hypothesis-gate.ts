import type { WorkMode } from "@/lib/schemas";
import {
  adoptInlineDebugHypothesis,
  debugWriteGateMessage,
  hasActiveDebugHypothesis,
  isDebugWriteTool,
} from "./debug-hypothesis-session";

/** Returns a JSON tool error string, or null if the call may proceed. */
export function debugWriteGateResult(
  chatId: number,
  toolName: string,
  workMode: WorkMode,
  args: unknown,
): string | null {
  if (workMode !== "debug") return null;
  if (!isDebugWriteTool(toolName)) return null;
  if (adoptInlineDebugHypothesis(chatId, args)) return null;
  if (hasActiveDebugHypothesis(chatId)) return null;
  return JSON.stringify({
    success: false,
    error: debugWriteGateMessage(),
    operation: toolName,
    denied: true,
  });
}
