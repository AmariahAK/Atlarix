/**
 * Fix: Workforce-2 — in-memory per-chat Workforce scope (not SQLite / file store).
 * Cleared on New Chat via IPC.
 */

export type WorkforceChatSession = {
  /** User-provided scope for this chat (Slack focus, repos, projects, etc.). */
  scopeNote: string;
  updatedAt: number;
};

const sessionByChatId = new Map<number, WorkforceChatSession>();

export function getWorkforceChatSession(chatId: number): WorkforceChatSession | undefined {
  return sessionByChatId.get(chatId);
}

export function setWorkforceChatSessionScope(chatId: number, scopeNote: string): void {
  const trimmed = scopeNote.trim();
  if (!trimmed) {
    sessionByChatId.delete(chatId);
    return;
  }
  sessionByChatId.set(chatId, { scopeNote: trimmed, updatedAt: Date.now() });
}

export function clearWorkforceChatSession(chatId: number): void {
  sessionByChatId.delete(chatId);
}
