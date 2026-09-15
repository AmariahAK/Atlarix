/**
 * What Atlarix remembers about the user — notes, not sentences.
 *
 * REPLACES a store of 50 one-sentence facts, every one of which was pasted into
 * the system prompt in full on every round. The shape is the desktop's
 * (`src/lib/agent-memory.ts`): an index of one line per note, and bodies read on
 * demand.
 *
 * ONLY THE INDEX EVER ENTERS THE PROMPT. That single rule is the whole design.
 * At 26 KB a note is ~6,500 tokens against a total per-round overhead of
 * ~4,100, so injecting one body would be strictly worse than the thing this
 * replaces. Cost now scales with the NUMBER of notes, never their size.
 *
 * TWO KINDS OF KEY, NOT ONE BLOB. `sessions/store.ts` already states the
 * reason and it applies harder here: `chrome.storage.local` has no partial
 * write, so one array of 30 notes means re-serialising up to 512 KB to change a
 * 40-character description.
 *
 * THE INDEX IS DERIVED, NEVER AUTHORED — the one deliberate divergence from the
 * desktop, where `MEMORY.md` is a file the agent hand-maintains and
 * `readMemoryIndex` already has to cope with it drifting. Deriving it deletes
 * that failure class (write a note, forget the index line, note is invisible
 * forever), deletes a second write the model has to remember, and — once the
 * launchpad can edit notes too — avoids a third concurrent writer on a document
 * nobody can merge.
 *
 * TREAT WHAT IS READ BACK AS UNTRUSTED, exactly as the old store did:
 * `storage.local` is a LevelDB directory any local process running as the user
 * can rewrite. Every read validates shape and drops what is malformed rather
 * than throwing later, in a prompt builder, on some unrelated turn.
 */

import { api } from "../shared/browser-api";
import {
  DESCRIPTION_MAX,
  NAME_MAX,
  TITLE_MAX,
  byteLength,
} from "./limits";

const INDEX_KEY = "atlarix.notes.index.v1";
const notePrefix = (name: string) => `atlarix.note.${name}.v1`;

/** The desktop's four, unchanged, so its written convention transfers whole. */
export const NOTE_TYPES = [
  "project",
  "feedback",
  "reference",
  "user",
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface NoteMeta {
  /** The "filename". `.md` is implied and never stored. */
  name: string;
  title: string;
  /**
   * THE RETRIEVAL KEY, and the only thing the model has when deciding whether
   * a note is worth opening. The convention — write it to match the SYMPTOM you
   * would be having, not as a title — lives in the tool description, where it
   * is read at the moment it is needed.
   */
  description: string;
  type: NoteType;
  /**
   * UTF-8 byte length of the body.
   *
   * DENORMALISED ON PURPOSE. Prompt building runs every turn and must not open
   * 30 note keys to compute a total — the same reasoning as the denormalised
   * `user_id` on `conversation_messages`.
   */
  bytes: number;
  updatedAt: number;
  /** Bumped on every local write. Drives sync's compare-and-swap. */
  rev: number;
  /** The last `rev` the server confirmed. `rev > syncedRev` = unpushed edits. */
  syncedRev: number;
}

export interface Note extends NoteMeta {
  body: string;
  createdAt: number;
}

/* ── Validation ───────────────────────────────────────────────────────────── */

/** Lowercase, hyphens, bounded — so a name is always a safe storage key. */
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= NAME_MAX &&
    NAME_SHAPE.test(name)
  );
}

/** `Some Title!` → `some-title`. Empty when nothing usable survives. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX)
    .replace(/-+$/g, "");
}

function isNoteType(v: unknown): v is NoteType {
  return (
    typeof v === "string" && (NOTE_TYPES as readonly string[]).includes(v)
  );
}

function isMeta(v: unknown): v is NoteMeta {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    isValidName(m.name) &&
    typeof m.title === "string" &&
    typeof m.description === "string" &&
    isNoteType(m.type) &&
    typeof m.bytes === "number" &&
    Number.isFinite(m.bytes) &&
    typeof m.updatedAt === "number" &&
    typeof m.rev === "number" &&
    typeof m.syncedRev === "number"
  );
}

function isNote(v: unknown): v is Note {
  if (!isMeta(v)) return false;
  const n = v as unknown as Record<string, unknown>;
  return typeof n.body === "string" && typeof n.createdAt === "number";
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

/** Every note's metadata, newest first. Never throws; drops malformed rows. */
export async function listNotes(): Promise<NoteMeta[]> {
  try {
    const bag = await api().storage.local.get<Record<string, unknown>>(
      INDEX_KEY,
    );
    const raw = (bag?.[INDEX_KEY] as { notes?: unknown })?.notes;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isMeta).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** One note in full, or null. */
export async function readNote(name: string): Promise<Note | null> {
  if (!isValidName(name)) return null;
  const key = notePrefix(name);
  try {
    const bag = await api().storage.local.get<Record<string, unknown>>(key);
    const raw = bag?.[key];
    return isNote(raw) ? raw : null;
  } catch {
    return null;
  }
}

/* ── Writing ──────────────────────────────────────────────────────────────── */

async function writeIndex(notes: NoteMeta[]): Promise<void> {
  await api().storage.local.set({ [INDEX_KEY]: { notes } });
}

export interface SaveInput {
  name: string;
  title: string;
  description: string;
  type: NoteType;
  body: string;
}

/**
 * Create or replace a note.
 *
 * NO SIZE OR FULLNESS CHECK HERE — that is `compaction.ts`'s job and the
 * caller's. This function's contract is storage: it writes what it is given and
 * keeps the index in step. Mixing the two would mean the refusal text (which
 * has to name the note and the overage) lived in the layer with no vocabulary
 * for saying so.
 */
export async function saveNote(input: SaveInput): Promise<Note> {
  const existing = await readNote(input.name);
  const now = Date.now();
  const note: Note = {
    name: input.name,
    title: input.title.slice(0, TITLE_MAX),
    description: input.description.slice(0, DESCRIPTION_MAX),
    type: input.type,
    body: input.body,
    bytes: byteLength(input.body),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    rev: (existing?.rev ?? 0) + 1,
    // Deliberately NOT carried over: this write has not been pushed, and
    // inheriting the old value would mark a dirty note clean.
    syncedRev: existing?.syncedRev ?? 0,
  };

  // THE NOTE BEFORE THE INDEX. If the second write fails, the store holds a
  // note nothing points at — recoverable, invisible, harmless. The other order
  // leaves an index line pointing at a body that does not exist, which is a
  // broken read the model cannot explain.
  await api().storage.local.set({ [notePrefix(note.name)]: note });
  const index = await listNotes();
  const { body: _body, createdAt: _createdAt, ...meta } = note;
  await writeIndex([...index.filter((m) => m.name !== note.name), meta]);
  return note;
}

/**
 * Record that the server has seen this note at `syncedRev`.
 *
 * BOOKKEEPING, NOT AN EDIT, which is why it does not go through `saveNote` —
 * that bumps `rev`, and a bump here would mark the note dirty again the instant
 * it was marked clean, so every note would push forever.
 *
 * It also re-checks `rev` before writing: the model may have written again while
 * the push was in flight, and marking THAT write synced would lose it.
 */
export async function markNoteSynced(
  name: string,
  expectedRev: number,
  syncedRev: number,
): Promise<void> {
  const note = await readNote(name);
  if (!note || note.rev !== expectedRev) return;

  await api().storage.local.set({
    [notePrefix(name)]: { ...note, syncedRev },
  });
  const index = await listNotes();
  await writeIndex(
    index.map((m) => (m.name === name ? { ...m, syncedRev } : m)),
  );
}

/** Delete one note. Returns false when there was nothing to delete. */
export async function deleteNote(name: string): Promise<boolean> {
  if (!isValidName(name)) return false;
  const index = await listNotes();
  if (!index.some((m) => m.name === name)) return false;
  await writeIndex(index.filter((m) => m.name !== name));
  await api().storage.local.remove(notePrefix(name));
  return true;
}

/**
 * Erase everything.
 *
 * ENUMERATES THE PER-NOTE KEYS. The old store was one key and its `forgetAll`
 * removed one key; with a key per note, removing only the index would leave
 * every body on disk while the UI reported an empty store. `sessions/store.ts`
 * records the same trap for archives — an orphaned key is invisible until
 * someone goes looking for a storage leak.
 */
export async function deleteAllNotes(): Promise<void> {
  const index = await listNotes();
  await api().storage.local.remove([
    INDEX_KEY,
    ...index.map((m) => notePrefix(m.name)),
  ]);
}
