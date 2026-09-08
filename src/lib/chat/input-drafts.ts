/**
 * Unsent composer text, kept per SESSION and across app restarts.
 *
 * Typing a long message and quitting used to lose it, which forces the user to
 * retype something they may no longer remember. Requested 2026-09-06.
 *
 * KEYED BY SESSION UUID, NOT CHAT ID, and that is the whole design decision.
 * `chatId` is a renderer transport id handed out per run by
 * `allocateSessionTransport` — it does not survive a restart, so a draft filed
 * under one would be orphaned on the next launch while still occupying storage.
 * The session UUID is the identifier the DB and the renderer agree on
 * (`chatIdToSessionIdAtom`), so it is the only key that survives.
 *
 * A corollary worth stating: a draft typed before a session has a UUID is NOT
 * persisted. That window is between allocating a chat transport and activating
 * the session, and is a few milliseconds at open; dropping it is much better than
 * inventing a second key space and then having to migrate between them.
 *
 * PER SESSION, not globally, because a draft belongs to the conversation it was
 * typed in. `chatInputValueAtom` is a single global string, so before this the
 * text followed you into whatever session you switched to — and `layout.tsx`
 * carried a `setChatInput("")` on workspace change purely to paper over that.
 *
 * Storage is `localStorage`, which is per-viewer, survives a restart, and is
 * allowed to be missing or to throw (a locked-down profile, cleared site data).
 * Every access is wrapped: losing a draft is a disappointment, and throwing while
 * rendering the composer is a broken app.
 */

const KEY = "atlarix:chat-drafts";
/** Guards against one runaway paste filling the quota for every other session. */
const MAX_DRAFT_CHARS = 100_000;
/** Oldest drafts are dropped past this, so the store cannot grow without bound. */
const MAX_SESSIONS = 50;

type DraftStore = Record<string, { text: string; at: number }>;

function readStore(): DraftStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as DraftStore;
  } catch {
    // Unreadable or unparseable: behave as if there were no drafts. Do not try
    // to repair it — a corrupt store is not worth more code than this.
    return {};
  }
}

function writeStore(store: DraftStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Quota, or storage disabled. Nothing useful to do and nothing to tell the
    // user: their text is still on screen, it just will not survive a quit.
  }
}

/** The saved draft for a session, or "" when there is none. */
export function loadDraft(sessionId: string | null | undefined): string {
  if (!sessionId) return "";
  const entry = readStore()[sessionId];
  return typeof entry?.text === "string" ? entry.text : "";
}

/**
 * Save (or, for empty text, clear) the draft for one session.
 *
 * Empty text DELETES rather than storing "": an empty draft is the absence of a
 * draft, and keeping it would let the store fill with the residue of every
 * session the user ever opened and sent from.
 */
export function saveDraft(
  sessionId: string | null | undefined,
  text: string,
): void {
  if (!sessionId) return;
  const store = readStore();
  if (!text.trim()) {
    if (!(sessionId in store)) return;
    delete store[sessionId];
    writeStore(store);
    return;
  }
  store[sessionId] = { text: text.slice(0, MAX_DRAFT_CHARS), at: Date.now() };
  const ids = Object.keys(store);
  if (ids.length > MAX_SESSIONS) {
    ids
      .sort((a, b) => (store[a]?.at ?? 0) - (store[b]?.at ?? 0))
      .slice(0, ids.length - MAX_SESSIONS)
      .forEach((id) => delete store[id]);
  }
  writeStore(store);
}

/** Drop a session's draft — on send, and when its session is deleted. */
export function clearDraft(sessionId: string | null | undefined): void {
  saveDraft(sessionId, "");
}
