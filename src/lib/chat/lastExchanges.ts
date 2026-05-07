import type { Message } from "@/ipc/ipc_types";

/**
 * Return only the last N user+assistant exchanges.
 * - Exchange = (user message) + (assistant message) pairs.
 * - Keeps ordering stable.
 * - Ensures the returned list starts on a user message (when possible).
 */
export function sliceLastExchanges(
  messages: Message[],
  maxExchanges: number,
): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (maxExchanges <= 0) return [];

  // Only user/assistant participate in exchange counting (system rows would just waste UI space).
  const nonSystem = messages.filter(
    (m) => m && (m.role === "user" || m.role === "assistant"),
  );
  const maxMsgs = maxExchanges * 2;
  if (nonSystem.length <= maxMsgs) return nonSystem;

  let recent = nonSystem.slice(-maxMsgs);
  // Ensure we start at a user turn for clean alternation.
  if (recent.length > 0 && recent[0]?.role !== "user") {
    const firstUser = recent.findIndex((m) => m.role === "user");
    recent = firstUser >= 0 ? recent.slice(firstUser) : [];
  }

  return recent;
}

