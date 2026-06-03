import {
  adoptInlineDebugHypothesis,
  debugWriteGateMessage,
  hasActiveDebugHypothesis,
} from "./debug-hypothesis-session";

export function debugWriteHandlerDenied(
  chatMode: string | undefined,
  chatSessionId: number | undefined,
  args?: unknown,
): { error: string; operation: string; denied: true } | null {
  if (chatMode !== "debug") return null;
  const chatId = chatSessionId;
  if (chatId != null && chatId > 0) {
    if (adoptInlineDebugHypothesis(chatId, args)) return null;
    if (hasActiveDebugHypothesis(chatId)) return null;
  }
  return {
    error: debugWriteGateMessage(),
    operation: "debug_write",
    denied: true,
  };
}
