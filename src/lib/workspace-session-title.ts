import { getDefaultStore } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { isLowQualityGeneratedTitle } from "@/lib/session-title/title-quality";
import {
  workspaceSessionsRefreshAtom,
  workspaceSessionTitleGeneratingAtom,
} from "@/atoms/sessionAtoms";
import { updateOpenChatTabTitleForSession } from "@/lib/open-workspace-session";

export const DEFAULT_SESSION_TITLE = "Untitled";

const DEFAULT_SESSION_TITLES = new Set([
  DEFAULT_SESSION_TITLE,
  "New session",
  "New chat",
]);

export function isDefaultSessionTitle(title: string): boolean {
  return DEFAULT_SESSION_TITLES.has(title.trim());
}

/**
 * UNICODE-AWARE SANITISING, because `\w` is ASCII-only and silently ate titles.
 *
 * The class was `[^\w\s-]`, and JavaScript's `\w` without the `u` flag is exactly
 * `[A-Za-z0-9_]`. Every other script was therefore replaced with spaces. Measured
 * 2026-09-08, once the response-language setting made non-English replies the
 * point rather than an accident:
 *
 *   Russian  "Добавить gitignore и удалить секреты" → "gitignore"
 *   Chinese  "添加 gitignore 并删除密钥"              → "gitignore"
 *   Japanese "gitignore を追加して秘密を削除"          → "gitignore"
 *   Hindi    "gitignore जोड़ें और रहस्य हटाएं"          → "gitignore"
 *   Turkish  "gitignore ekle ve sırları kaldır"    → "gitignore ekle ve s rlar kald"
 *   German   "Füge gitignore hinzu"                → "F ge gitignore hinzu"
 *
 * Four locales collapsed to whatever Latin identifier happened to appear, and the
 * two Latin-script ones were mangled MID-WORD — which is worse, because it looks
 * like a title rather than like a failure. `ı`, `ü`, `ş` are not ASCII either.
 *
 * `\p{L}\p{N}\p{M}` with the `u` flag keeps letters, digits and COMBINING MARKS in
 * any script, while still stripping punctuation and emoji — which is what the
 * class was for.
 *
 * `\p{M}` is not optional and was missed on the first attempt. Devanagari builds
 * syllables from a letter plus a vowel sign (`जो` = ज + ो), and a vowel sign is a
 * Mark, not a Letter — so keeping only `\p{L}` still broke Hindi apart from the
 * inside: "gitignore जोड़ें और रहस्य हटाएं" became "gitignore ज ड और रहस य". The
 * same is true of Arabic, Hebrew and Thai if they are ever added.
 */
export function extractAtlarixChatSummary(content: string): string | null {
  const match = content.match(
    /<atlarix-chat-summary>([\s\S]*?)<\/atlarix-chat-summary>/,
  );
  if (!match) return null;
  const raw = match[1]
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw || isLowQualityGeneratedTitle(raw)) return null;
  return raw.split(/\s+/).slice(0, 6).join(" ").slice(0, 80);
}

function setSessionTitleGenerating(
  sessionId: string,
  generating: boolean,
): void {
  const store = getDefaultStore();
  store.set(workspaceSessionTitleGeneratingAtom, (prev: Set<string>) => {
    const next = new Set(prev);
    if (generating) next.add(sessionId);
    else next.delete(sessionId);
    return next;
  });
}

/**
 * Keep the sidebar and open tabs in step with titles MAIN writes.
 *
 * Since v14.52.0 naming happens entirely in main, the moment the first user
 * message is saved: a placeholder from the user's own words at once, then the
 * generated title when it lands (`titleSessionFromFirstMessage`). Main pushes
 * each one here; nothing in the renderer decides when to name a session any
 * more, which is what retired the per-chat attempt counters.
 *
 * Idempotent per window — call once at startup. Returns the unsubscribe.
 */
export function subscribeToSessionTitleUpdates(): () => void {
  return IpcClient.getInstance().onSessionTitleUpdated(({ sessionId, title }) => {
    getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
    // The tab strip holds a title SNAPSHOT — push the new name into any open
    // tab for this session or it keeps the old one.
    updateOpenChatTabTitleForSession(sessionId, title);
  });
}

/**
 * The first prompt was edited, so the title derived from it is stale.
 *
 * Only the FIRST message feeds the title, so only an edit to it re-titles; a
 * title the user typed is protected in main (`titleSource === "user"`).
 */
export async function regenerateSessionTitle(sessionId: string): Promise<void> {
  setSessionTitleGenerating(sessionId, true);
  try {
    const { title } =
      await IpcClient.getInstance().generateWorkspaceSessionTitle(sessionId);
    if (title && !isDefaultSessionTitle(title)) {
      getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
      updateOpenChatTabTitleForSession(sessionId, title);
    }
  } catch (e) {
    console.error("Failed to regenerate the session title:", e);
  } finally {
    setSessionTitleGenerating(sessionId, false);
  }
}
