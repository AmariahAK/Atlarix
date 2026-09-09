import { getDefaultStore } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { isLowQualityGeneratedTitle } from "@/utils/chat_naming";
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
 * Chats whose title has already been generated this run.
 *
 * Module-level rather than a component ref because two places need it: the
 * stream hook (which generates after the first exchange) and the composer
 * (which must ALLOW a regeneration when the first prompt is edited). A ref in
 * one component is unreachable from the other.
 */
const titleGeneratedChats = new Set<number>();

/**
 * Attempts spent on chats that have not produced a title yet.
 *
 * A single unconditional attempt was the second half of the "Untitled forever"
 * bug: the caller marked the chat done BEFORE generating, so a first turn with
 * nothing nameable in it burned the only chance. Two live sessions sat at 10 and
 * 20 messages still called "Untitled" — by turn two there was ample material.
 *
 * Bounded rather than unbounded: a session that genuinely cannot be named stops
 * asking instead of spending a title call every turn, forever.
 */
const titleAttemptsByChat = new Map<number, number>();
const MAX_TITLE_ATTEMPTS = 3;

/** True when this chat still needs a generated title. */
export function needsGeneratedTitle(chatId: number): boolean {
  if (titleGeneratedChats.has(chatId)) return false;
  return (titleAttemptsByChat.get(chatId) ?? 0) < MAX_TITLE_ATTEMPTS;
}

export function markTitleGenerated(chatId: number): void {
  titleGeneratedChats.add(chatId);
  titleAttemptsByChat.delete(chatId);
}

/** An attempt that produced nothing — spend one try, but keep the door open. */
export function noteTitleAttemptFailed(chatId: number): void {
  titleAttemptsByChat.set(chatId, (titleAttemptsByChat.get(chatId) ?? 0) + 1);
}

/**
 * The first prompt changed, so the title derived from it is stale — let the next
 * completed turn regenerate it.
 *
 * Only the FIRST exchange feeds the title, so only an edit to it should reopen
 * this; editing a later message leaves the title alone. A title the user typed
 * by hand is still protected downstream by `titleSource === "user"`.
 */
export function allowRetitleAfterFirstPromptEdit(chatId: number): void {
  titleGeneratedChats.delete(chatId);
  titleAttemptsByChat.delete(chatId);
}

/**
 * Async AI title from first user + assistant messages after the first turn
 * completes. Returns whether a real title landed, so the caller knows whether
 * this chat is done or should try again on the next turn.
 */
export async function applyAIWorkspaceSessionTitle(
  sessionId: string,
): Promise<boolean> {
  setSessionTitleGenerating(sessionId, true);
  try {
    // `limit: 1` because only `session.titleSource` is read below. Unbounded, this
    // pulled every message body, modelContent and display snapshot in the session
    // across IPC — megabytes on a long session — and discarded all of it, after
    // every completed turn.
    const { session } = await IpcClient.getInstance().getWorkspaceSession(
      sessionId,
      {
        limit: 1,
      },
    );
    // Ownership, not "is it still Untitled". Re-deriving a title the USER typed
    // would be worse than never re-titling; re-deriving one we generated is the
    // whole point when the prompt it came from has changed.
    // A title the user typed is theirs — done, and never retry.
    if (session.titleSource === "user") return true;

    const { title } =
      await IpcClient.getInstance().generateWorkspaceSessionTitle(sessionId);
    if (
      title &&
      !isDefaultSessionTitle(title) &&
      !isLowQualityGeneratedTitle(title)
    ) {
      getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
      // v14.8.11: the tab strip holds a title SNAPSHOT — push the new name
      // into any open tab for this session or it stays "Untitled" forever.
      updateOpenChatTabTitleForSession(sessionId, title);
      return true;
    }

    // THE AI PATH PRODUCED NOTHING — fall back to the user's own words.
    //
    // Why this matters more than tidiness. Generation needs an assistant reply to
    // summarise, so a turn that ERRORED yields no title. But the user's message has
    // already persisted, which leaves the session in a state that is neither nameable
    // nor reusable: `pickSessionReuse` only reuses a session with zero messages, so the
    // next "New chat" creates ANOTHER "Untitled". Every failed turn stranded one, and
    // they accumulated — two visible after two failures, observed 2026-09-08.
    //
    // The tempting fix is to loosen "empty" to "has no assistant reply" so those become
    // reusable again. DO NOT: `pickSessionReuse` also DELETES, and on 2026-08-31 a
    // correlation bug made every default-titled session look empty and cascaded real
    // conversations through `session_messages`. The title check is what limited the blast
    // radius. Naming the session instead solves the same symptom without widening
    // anything that can delete.
    return await applyFallbackSessionTitle(sessionId);
  } catch (e) {
    console.error("Failed to apply AI workspace session title:", e);
    return false;
  } finally {
    setSessionTitleGenerating(sessionId, false);
  }
}

/**
 * A title from the user's first message, with no model call.
 *
 * Deliberately dumb: the text is already in hand, so this cannot fail the way generation
 * can, which is the entire point — it is the path taken WHEN generation failed. Returns
 * true only if a title actually landed, so the caller's attempt accounting is unchanged.
 *
 * `titleSource` stays "auto". The user did not name this, and marking it "user" would
 * permanently block the real generated title from replacing it on a later successful turn.
 */
export async function applyFallbackSessionTitle(
  sessionId: string,
): Promise<boolean> {
  try {
    const ipc = IpcClient.getInstance();
    const { messages } = await ipc.getWorkspaceSession(sessionId, { limit: 4 });
    const firstUser = (messages ?? []).find(
      (m: { role?: string }) => m.role === "user",
    ) as { content?: unknown } | undefined;
    const title = summariseFirstPrompt(
      typeof firstUser?.content === "string" ? firstUser.content : "",
    );
    if (!title) return false;

    await ipc.renameWorkspaceSession(sessionId, title);
    getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
    updateOpenChatTabTitleForSession(sessionId, title);
    return true;
  } catch (e) {
    console.error("Failed to apply fallback workspace session title:", e);
    return false;
  }
}

/**
 * First line of a prompt, trimmed to something that fits a sidebar row.
 *
 * Attachment chips and pasted blocks arrive as part of the message, so this takes the
 * FIRST non-empty line rather than the first N characters — "hey how are you?" is a
 * better name than the opening of a 400-line paste. Returns null when there is nothing
 * nameable, which is a real case: a session opened by pasting text alone strips to "".
 */
const FALLBACK_TITLE_MAX = 48;

export function summariseFirstPrompt(content: string): string | null {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const cleaned = line.replace(/\s+/g, " ").trim();
  if (!cleaned || isDefaultSessionTitle(cleaned)) return null;
  return cleaned.length > FALLBACK_TITLE_MAX
    ? `${cleaned.slice(0, FALLBACK_TITLE_MAX - 1).trimEnd()}…`
    : cleaned;
}
