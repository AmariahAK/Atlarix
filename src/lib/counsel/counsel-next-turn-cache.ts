/**
 * Holds counsel synthesis from a background run for injection on the **next** user turn
 * (real `chatId` only; ephemeral chats skip storage).
 */
const counselNextTurnByChatId = new Map<number, string>();

export function storeCounselSynthesisForNextTurn(chatId: number, synthesis: string): void {
  if (chatId <= 0 || !synthesis.trim()) return;
  counselNextTurnByChatId.set(chatId, synthesis.trim());
}

/** Returns cached synthesis for this chat and removes it (consume-once). */
export function consumeCounselSynthesisForNextTurn(chatId: number): string | null {
  if (chatId <= 0) return null;
  const s = counselNextTurnByChatId.get(chatId);
  if (s == null) return null;
  counselNextTurnByChatId.delete(chatId);
  return s;
}
