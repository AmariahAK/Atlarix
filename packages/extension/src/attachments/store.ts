/**
 * Attached files, kept whole, on this device.
 *
 * WHY THE BODY LEFT THE MESSAGE. It used to live in the user message itself,
 * and `attachments.ts` said so in as many words — "the message IS the store".
 * That is what forced the 200,000-character truncation: a transcript is re-sent
 * in full on every round, so an inlined 5 MB log would be paid for on every
 * round and would fill the context window on the second one. The cap was the
 * symptom; the inlining was the cause.
 *
 * So the message now carries a PREVIEW and an id, and the body lives here.
 * Nothing is truncated — `read_attachment` pages as much of it as the model
 * asks for. This is the desktop's design (`src/lib/tools/workspace.ts`), which
 * reaches the same conclusion from the same constraint.
 *
 * SESSION-SCOPED KEYS, NOT A GLOBAL TABLE. Two hard problems disappear:
 *
 *   Lifetime — deleting a conversation deletes its attachments, because they
 *   share its key prefix. A global table would need reference counting, and the
 *   failure mode of getting that wrong is an orphan nobody can see that counts
 *   against the same ~10 MB quota forever. `sessions/store.ts` already carries a
 *   comment about exactly that hazard for transcripts.
 *
 *   Scope — a tool call cannot read another conversation's files, because it
 *   cannot name their key. The desktop does this with an `attachmentInScope`
 *   filter at read time; a prefix is the same rule expressed where it cannot be
 *   forgotten at a call site.
 *
 * THE ID IS THE CONTENT. A SHA-256 prefix, so attaching the same file twice
 * writes one entry, and a re-send after an edit resolves to the id the model was
 * already told about. A random id re-minted on rehydration is a bug the desktop
 * has already had and recorded.
 */

import { api } from "../shared/browser-api";

/** `atlarix.attachment.<sessionId>.<id>.v1` */
const PREFIX = "atlarix.attachment.";
const keyFor = (sessionId: string, id: string) =>
  `${PREFIX}${sessionId}.${id}.v1`;

/**
 * How much of a file the MESSAGE carries.
 *
 * The desktop's number. Large enough that most attachments are whole at a
 * glance — a config file, a stack trace, an error log — so the common case
 * costs no tool call at all, and small enough that a big file does not ride
 * every round. A file at or under this is fully inline and `hasMore` is false
 * the first time it is read.
 */
export const PREVIEW_CHARS = 1_500;

/** Lines per `read_attachment` page when the model does not say. */
export const DEFAULT_PAGE_LINES = 2_000;
/** The most lines one page may carry, however large `limit` is. */
export const MAX_PAGE_LINES = 10_000;
/**
 * The most characters one page may carry.
 *
 * Checked as well as the line count because a minified bundle is one line of
 * two megabytes, and a page bounded only by lines would hand the model the
 * whole file in a single "page" — which is the thing this exists to avoid.
 */
export const MAX_PAGE_CHARS = 200_000;

export interface StoredAttachment {
  id: string;
  name: string;
  /** The MIME type, as best we know it. Display and the model's benefit only. */
  type: string;
  /** The whole file, as text. Never truncated. */
  body: string;
}

function isStored(v: unknown): v is StoredAttachment {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    typeof a.type === "string" &&
    typeof a.body === "string"
  );
}

/**
 * A stable id for this exact content.
 *
 * `crypto.subtle` is available in the panel, which is a secure context. 32 hex
 * characters of SHA-256 — the desktop's length, and far past the point where a
 * collision between two files one person attached is worth a thought.
 */
export async function attachmentId(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Write a file's body and return its id. Idempotent for identical content. */
export async function putAttachment(
  sessionId: string,
  file: { name: string; type: string; body: string },
): Promise<string> {
  const id = await attachmentId(file.body);
  const record: StoredAttachment = {
    id,
    name: file.name,
    type: file.type,
    body: file.body,
  };
  await api().storage.local.set({ [keyFor(sessionId, id)]: record });
  return id;
}

/** One file in full, or null when this conversation has no such id. */
export async function getAttachment(
  sessionId: string,
  id: string,
): Promise<StoredAttachment | null> {
  // A key is interpolated from `id`, so a malformed one must not become a
  // lookup for something else. Ids we mint are hex; anything else is not ours.
  if (!/^[0-9a-f]{1,64}$/.test(id)) return null;
  try {
    const key = keyFor(sessionId, id);
    const bag = await api().storage.local.get<Record<string, unknown>>(key);
    const raw = bag?.[key];
    return isStored(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Everything attached in this conversation.
 *
 * Used to answer a bad id with the list of good ones. A model that mistypes an
 * id and is told only "not found" asks the user to attach the file again — the
 * one thing the prompt explicitly tells it not to do.
 */
export async function listAttachments(
  sessionId: string,
): Promise<StoredAttachment[]> {
  try {
    const bag = await api().storage.local.get<Record<string, unknown>>(null);
    const wanted = `${PREFIX}${sessionId}.`;
    return Object.entries(bag ?? {})
      .filter(([k]) => k.startsWith(wanted))
      .map(([, v]) => v)
      .filter(isStored);
  } catch {
    return [];
  }
}

/**
 * Forget every file attached in these conversations.
 *
 * Called when a conversation is deleted, when one is evicted past
 * `MAX_SESSIONS`, and by Erase everything — the same three places a transcript
 * is dropped, because an attachment outliving its conversation is unreachable
 * by design and would never be freed.
 */
export async function deleteSessionAttachments(
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  try {
    const bag = await api().storage.local.get<Record<string, unknown>>(null);
    const prefixes = sessionIds.map((id) => `${PREFIX}${id}.`);
    const doomed = Object.keys(bag ?? {}).filter((k) =>
      prefixes.some((p) => k.startsWith(p)),
    );
    if (doomed.length > 0) await api().storage.local.remove(doomed);
  } catch {
    // A conversation that could not be tidied is a quota cost, not a failure
    // the user can act on. Never throw out of a delete.
  }
}

export interface Page {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  hasMore: boolean;
}

/**
 * One page of a file, by line.
 *
 * LINES, NOT CHARACTERS, because a page boundary the model can name is what
 * makes the next call obvious — "continue from line 2001" is a request it can
 * form, "continue from character 412930" is one it gets wrong. Same reasoning as
 * the desktop's read_attachment and as read_file before it.
 *
 * The character ceiling still applies, and when it bites the page ends early —
 * but always after at least one line, or a single enormous line could never be
 * read at all.
 */
export function pageOf(
  body: string,
  offset: number,
  limit: number,
): Page {
  const lines = body.split("\n");
  const totalLines = lines.length;
  const start = Math.min(Math.max(1, Math.floor(offset) || 1), totalLines);
  const want = Math.min(
    Math.max(1, Math.floor(limit) || DEFAULT_PAGE_LINES),
    MAX_PAGE_LINES,
  );

  const out: string[] = [];
  let chars = 0;
  let line = start;
  while (line <= totalLines && out.length < want) {
    const next = lines[line - 1];
    // `out.length === 0` is what guarantees progress: without it a first line
    // longer than the ceiling would return an empty page forever.
    if (out.length > 0 && chars + next.length > MAX_PAGE_CHARS) break;
    out.push(next);
    chars += next.length + 1;
    line += 1;
  }

  return {
    text: out.join("\n"),
    startLine: start,
    endLine: line - 1,
    totalLines,
    hasMore: line - 1 < totalLines,
  };
}
