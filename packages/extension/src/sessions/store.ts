/**
 * Conversations, kept on this device.
 *
 * TWO KEYS PER CONVERSATION, NOT ONE BIG ONE. An index holds the titles and
 * dates; each transcript lives under its own key. `chrome.storage.local` has no
 * partial write — setting a key rewrites its whole value — so one array of
 * every session would mean serialising every transcript the user has ever had
 * on each round of the current one. A single page read is tens of kilobytes,
 * and this runs after every round.
 *
 * WHY SAVE AFTER EVERY ROUND AT ALL. Because the loop runs in the side panel,
 * and closing the panel destroys it mid-turn (see `agent/loop.ts` for why it
 * runs there and not in a worker or an offscreen document). Persisting per
 * round is what turns "the panel closed and the work is gone" into "the panel
 * closed and everything up to the last completed round is still here". It does
 * not pretend the turn survived — nothing can do that — it just refuses to lose
 * what was already finished.
 *
 * NO SYNC, AND NOT BECAUSE IT WOULD BE HARD. `storage.sync` caps an item at
 * 8 KB, which one page read exceeds on its own. Cross-device history belongs
 * behind the account in Phase 4, not behind Chrome Sync.
 *
 * EVERYTHING READ BACK IS VALIDATED. The same reasoning as `memory/notes.ts`
 * and `auth/session.ts`: this is a LevelDB directory on disk, and a malformed
 * transcript must come back as an empty conversation rather than throw inside a
 * render.
 */

import type { CoreMessage } from "../core/client";
import { isCompactionMarker } from "../context/compact";
import { api } from "../shared/browser-api";
import { deleteSessionAttachments } from "../attachments/store";
import { deleteSessionRelics } from "../relics/store";
import { dropAllFiles, dropSessionFiles } from "../files/store";

const INDEX_KEY = "atlarix.sessions.v1";
const transcriptKey = (id: string) => `atlarix.session.${id}.v1`;
/**
 * Retired 2026-09-23: the panel used to reopen the conversation it was last
 * showing; it now always opens on a new one. Kept only so "erase everything"
 * still clears the value older builds wrote.
 */
const LEGACY_OPEN_KEY = "atlarix.openSession.v1";

/**
 * How many conversations are kept.
 *
 * A history list nobody scrolls past the first screen of, against a disk
 * budget shared with the page reads inside each one. Twenty is roughly a
 * fortnight of ordinary use.
 */
export const MAX_SESSIONS = 20;

/**
 * When a transcript is pruned before being sent to the model, in characters.
 *
 * ~4 chars per token, so 400k is on the order of 100k tokens — comfortably
 * inside every Core tier while leaving room for the reply. It is a guard, not a
 * routine step: an ordinary conversation never reaches it, and one that does
 * has read a dozen pages and is about to get an unhelpfully expensive round.
 */
export const PRUNE_ABOVE_CHARS = 400_000;

/** How many recent tool results keep their full text when pruning. */
export const KEEP_RECENT_TOOL_RESULTS = 6;

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /**
   * The title was written for this conversation rather than derived from its
   * first message.
   *
   * WITHOUT THIS FLAG the derived title wins forever: `saveSession` runs after
   * every round, and a title recomputed each time overwrites the generated one
   * the moment the next round lands. The generated title would appear for about
   * two seconds and then vanish, which reads as a bug in the generator.
   */
  titled?: boolean;
}

function isMeta(value: unknown): value is SessionMeta {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.title === "string" &&
    typeof m.createdAt === "number" &&
    typeof m.updatedAt === "number"
  );
}

function isMessage(value: unknown): value is CoreMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  switch (m.role) {
    case "system":
      return typeof m.content === "string";
    case "user":
      // A parts array is as valid as a string. Without this branch, a message
      // with an attachment fails validation on read-back and the conversation
      // silently loses the turn it was asked about — the one case where the
      // user can SEE that something vanished.
      return typeof m.content === "string" || Array.isArray(m.content);
    case "assistant":
      return typeof m.content === "string" || m.content === null;
    case "tool":
      return (
        typeof m.tool_call_id === "string" && typeof m.content === "string"
      );
    default:
      return false;
  }
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

/** Conversations, most recently updated first. Never throws. */
export async function listSessions(): Promise<SessionMeta[]> {
  try {
    const bag =
      await api().storage.local.get<Record<string, unknown>>(INDEX_KEY);
    const raw = bag?.[INDEX_KEY];
    const list = Array.isArray(raw) ? raw.filter(isMeta) : [];
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function loadSession(id: string): Promise<CoreMessage[]> {
  try {
    const key = transcriptKey(id);
    const bag = await api().storage.local.get<Record<string, unknown>>(key);
    const raw = bag?.[key];
    return Array.isArray(raw) ? raw.filter(isMessage) : [];
  } catch {
    return [];
  }
}

/**
 * A conversation's name, taken from what the user first asked.
 *
 * Derived rather than model-generated: naming a chat is not worth a round trip,
 * and a title that appears two seconds after the list renders is worse than one
 * that was right immediately.
 */
export function titleFor(messages: CoreMessage[]): string {
  // A compaction marker is a `user` row that the user did not write. Naming a
  // conversation after one produces "[COMPACTION MARKER] gen=2 ## Goal…" in the
  // drawer — which is exactly the conversation long enough to need finding.
  const first = messages.find((m) => m.role === "user" && !isCompactionMarker(m));
  const text =
    first && typeof first.content === "string" ? first.content.trim() : "";
  if (!text) return "New conversation";
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** Write a transcript and refresh its index entry. Returns what was evicted. */
export async function saveSession(
  id: string,
  messages: CoreMessage[],
  opts: { title?: string } = {},
): Promise<{ evicted: SessionMeta[] }> {
  const now = Date.now();
  const index = await listSessions();
  const existing = index.find((s) => s.id === id);

  // A written title, then a previously written one, then the derived fallback.
  // The order is what stops the per-round save from undoing the generator.
  const written = opts.title?.trim();
  const titled = Boolean(written) || existing?.titled === true;
  const meta: SessionMeta = {
    id,
    title: written || (existing?.titled ? existing.title : titleFor(messages)),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(titled ? { titled: true } : {}),
  };

  const next = [meta, ...index.filter((s) => s.id !== id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const evicted = next.slice(MAX_SESSIONS);

  await api().storage.local.set({
    [INDEX_KEY]: next.slice(0, MAX_SESSIONS),
    [transcriptKey(id)]: messages,
  });
  // The transcripts of evicted sessions go too — an orphaned one is invisible
  // and counts against the same quota forever. Their attachments go with them
  // for the same reason, and attachments are the larger of the two: a
  // transcript is prose, an attachment can be a twenty-megabyte log.
  if (evicted.length > 0) {
    await api().storage.local.remove(evicted.map((s) => transcriptKey(s.id)));
    const ids = evicted.map((s) => s.id);
    await deleteSessionAttachments(ids);
    await deleteSessionRelics(ids);
    // Files the model built are in memory rather than storage, so this frees
    // RAM rather than quota — but leaving them would keep a deleted
    // conversation's spreadsheets alive for as long as the panel stayed open.
    dropSessionFiles(ids);
  }
  return { evicted };
}

export async function deleteSession(id: string): Promise<void> {
  const index = await listSessions();
  await api().storage.local.set({
    [INDEX_KEY]: index.filter((s) => s.id !== id),
  });
  await api().storage.local.remove(transcriptKey(id));
  await deleteSessionAttachments([id]);
  await deleteSessionRelics([id]);
  dropSessionFiles([id]);
}

export async function deleteAllSessions(): Promise<void> {
  const index = await listSessions();
  await api().storage.local.remove([
    INDEX_KEY,
    LEGACY_OPEN_KEY,
    ...index.map((s) => transcriptKey(s.id)),
  ]);
  // Erase everything has to mean everything. An attached file left behind is
  // unreachable — nothing indexes it once the conversation is gone — and it is
  // also the biggest thing the user just asked to be rid of.
  await deleteSessionAttachments(index.map((s) => s.id));
  await deleteSessionRelics(index.map((s) => s.id));
  // EVERY session, not just the indexed ones. A file made in a conversation
  // that was never written to the index would otherwise survive the one gesture
  // whose entire promise is that nothing does.
  dropAllFiles();
}

/**
 * Shrink a transcript that has grown past what is worth sending.
 *
 * OLD TOOL RESULTS GO FIRST, and only tool results. They are the bulk by a wide
 * margin — a page read is tens of kilobytes and a user's question is tens of
 * bytes — and they are the one part of a conversation that can be REGENERATED:
 * the model can read the page again. Dropping the user's own words to save
 * space would be trading the irreplaceable for the reproducible.
 *
 * The placeholder says explicitly that the content was dropped and can be
 * re-read. A truncated result with no marker is worse than none at all: the
 * model treats half a page as the whole page.
 */
export function pruneForModel(messages: CoreMessage[]): CoreMessage[] {
  const size = messages.reduce(
    (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
  if (size <= PRUNE_ABOVE_CHARS) return messages;

  const toolIndexes = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const keepFrom = toolIndexes.length - KEEP_RECENT_TOOL_RESULTS;
  const drop = new Set(toolIndexes.slice(0, Math.max(0, keepFrom)));

  return messages.map((m, i) =>
    drop.has(i) && m.role === "tool"
      ? {
          ...m,
          content:
            "[Earlier tool result dropped to keep this conversation within the " +
            "model's context. If you still need it, call the tool again.]",
        }
      : m,
  );
}

/**
 * Discard everything from the Nth user message onwards.
 *
 * WHAT "EDIT" ACTUALLY MEANS in a conversation: a rewind, not a patch.
 * Everything after the edited message was a RESPONSE to the old wording — tool
 * results the model asked for because of it, answers that quoted it — and
 * keeping any of it leaves the model reading an exchange that never happened.
 *
 * The subtle part is that a "message" the user sees is one of several in the
 * transcript: their question, the assistant's reply, and every tool call and
 * result in between. Counting user messages and cutting at the whole transcript
 * index is what keeps those together.
 *
 * Returns the input unchanged when `nth` does not exist, so a stale index from a
 * re-render cannot silently empty a conversation.
 */
export function rewindToUserMessage(
  history: CoreMessage[],
  nth: number,
): CoreMessage[] {
  if (nth < 0) return history;
  let seen = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== "user") continue;
    // MUST MATCH THE PANEL'S RENDER EXACTLY. A compaction marker is a `user`
    // row nobody typed, and the transcript draws it as a divider without
    // advancing its counter. If this counted it, every index after the first
    // compaction would be off by one and editing a question would rewind to the
    // previous one — silently, and only in conversations long enough to have
    // been compacted.
    if (isCompactionMarker(history[i])) continue;
    if (seen === nth) return history.slice(0, i);
    seen += 1;
  }
  return history;
}
