/**
 * Holds parallel research+architect combined markdown for injection on the **next** user turn
 * (real `chatId` only; ephemeral chats skip storage). Same lifecycle as counsel-next-turn-cache.
 */
const parallelPrefetchNextTurnByChatId = new Map<number, string>();

export function storeParallelPrefetchForNextTurn(chatId: number, markdown: string): void {
  if (chatId <= 0 || !markdown.trim()) return;
  parallelPrefetchNextTurnByChatId.set(chatId, markdown.trim());
}

/** Returns cached prefetch markdown for this chat and removes it (consume-once). */
export function consumeParallelPrefetchForNextTurn(chatId: number): string | null {
  if (chatId <= 0) return null;
  const s = parallelPrefetchNextTurnByChatId.get(chatId);
  if (s == null) return null;
  parallelPrefetchNextTurnByChatId.delete(chatId);
  return s;
}
