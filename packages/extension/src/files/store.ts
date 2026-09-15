/**
 * Files the model built, held in memory for as long as the panel is open.
 *
 * ══ WHY A `Map` AND NOT `chrome.storage`, WHICH EVERYTHING ELSE HERE USES ══
 *
 * Attachments and relics both persist, and both are text. These are bytes, and
 * the instruction they were built to is explicit: "as long as it does not
 * affect the storage and does not get saved beyond the session". A Map is the
 * literal reading, and the two practical arguments point the same way —
 * `chrome.storage` is JSON, so a Uint8Array would have to be base64 (a third
 * larger, and a 10 MB workbook becomes 13 MB of quota), and nothing here is
 * worth evicting a conversation for.
 *
 * ══ THE COST, STATED RATHER THAN DISCOVERED ══
 *
 * CLOSING THE SIDE PANEL LOSES ANY FILE THE USER HAS NOT SAVED. The transcript
 * comes back on reopening because it is stored; the bytes do not. That is why
 * `madeFilesNote` records the NAMES in the tool result — on a reopened
 * conversation the panel can still draw the card and say honestly that the file
 * is gone, instead of silently rendering nothing where a file used to be.
 *
 * It also means the Download button is the only thing that makes a file real,
 * which is why the card offers it immediately rather than behind a click-through.
 */

import type { SandboxFile } from "../sandbox/worker";

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  createdAt: number;
}

/** What the panel draws a card from, and what the tool result carries. */
export interface MadeFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * How many bytes one conversation may hold at once.
 *
 * Evicts OLDEST-FIRST rather than refusing, because the newest file is the one
 * the user just asked for. A refusal would make the tool fail for someone who
 * had simply been productive.
 */
export const MAX_SESSION_BYTES = 32 * 1024 * 1024;

const sessions = new Map<string, Map<string, StoredFile>>();

function bucket(sessionId: string): Map<string, StoredFile> {
  let found = sessions.get(sessionId);
  if (!found) {
    found = new Map<string, StoredFile>();
    sessions.set(sessionId, found);
  }
  return found;
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function describe(file: StoredFile): MadeFile {
  return {
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.bytes.length,
  };
}

/**
 * Keep what a run produced.
 *
 * A NEW ID EVERY TIME, even for an identical name — unlike an attachment, whose
 * id is a hash of its content. The model rebuilding a spreadsheet after a
 * correction must not silently replace the one already on screen, because the
 * user may well want the earlier one; two cards with the same name and
 * different sizes is a question they can answer, and a card that changed under
 * them is not.
 */
export function putFiles(
  sessionId: string,
  files: SandboxFile[],
): MadeFile[] {
  const store = bucket(sessionId);
  const made: MadeFile[] = [];

  for (const file of files) {
    const record: StoredFile = {
      id: newId(),
      name: file.name,
      mime: file.mime,
      bytes: file.bytes,
      createdAt: Date.now(),
    };
    store.set(record.id, record);
    made.push(describe(record));
  }

  let total = 0;
  for (const file of store.values()) total += file.bytes.length;
  // Insertion order is chronological, so the first key is the oldest — no sort
  // is needed and none should be added.
  for (const [id, file] of store) {
    if (total <= MAX_SESSION_BYTES) break;
    total -= file.bytes.length;
    store.delete(id);
  }

  return made;
}

export function getFile(sessionId: string, id: string): StoredFile | null {
  return sessions.get(sessionId)?.get(id) ?? null;
}

/**
 * A file by the name the model knows it as — the MOST RECENT with that name.
 *
 * The model names a file when it wants to read one back on a later call, and it
 * has only the name; ids never reach it. Most recent wins because a rebuilt
 * file is the one it means.
 */
export function findFileByName(
  sessionId: string,
  name: string,
): StoredFile | null {
  const store = sessions.get(sessionId);
  if (!store) return null;
  let found: StoredFile | null = null;
  for (const file of store.values()) {
    if (file.name === name) found = file;
  }
  return found;
}

export function listFiles(sessionId: string): StoredFile[] {
  return [...(sessions.get(sessionId)?.values() ?? [])];
}

/** Forget everything made in these conversations. */
export function dropSessionFiles(sessionIds: string[]): void {
  for (const id of sessionIds) sessions.delete(id);
}

/** Forget everything, everywhere. Used by Erase everything. */
export function dropAllFiles(): void {
  sessions.clear();
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * What the model is told, and how the panel finds the names again on reload.
 *
 * ONE DEFINITION FOR BOTH DIRECTIONS, the same rule `relicNote` records: the
 * tool result is the only durable trace, so its WORDING IS A CONTRACT. The
 * names are percent-encoded inside the marker because `safeName` permits commas
 * and spaces, and a list that cannot be split back apart is not a list.
 */
const MARKER = /\[files ([^\]]*)\]/;

export function madeFilesNote(files: MadeFile[]): string {
  const listed = files
    .map((f) => `${f.name} (${formatSize(f.size)})`)
    .join(", ");
  const marker = files.map((f) => encodeURIComponent(f.name)).join("|");
  return (
    `Made ${files.length} file${files.length === 1 ? "" : "s"} the user can ` +
    `download from this conversation: ${listed} [files ${marker}]. Do not ` +
    `paste the contents into your reply and do not offer to send them another ` +
    `way — say what is in them and what you would change.`
  );
}

/** The names out of a stored tool result, or null when it is some other result. */
export function readMadeFilesNote(content: string): string[] | null {
  const match = MARKER.exec(content);
  if (!match) return null;
  const raw = match[1] ?? "";
  if (!raw) return null;
  return raw.split("|").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      // A name that will not decode is still a name worth showing. Losing the
      // whole card over one bad escape would be the wrong trade.
      return part;
    }
  });
}
