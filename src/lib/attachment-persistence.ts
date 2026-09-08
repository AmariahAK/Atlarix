import type {
  AttachmentInfo,
  PasteAttachmentMeta,
  StoredFileAttachment,
} from "@/ipc/ipc_types";
import { AttachmentStore, type AttachmentData } from "@/lib/attachment-store";

export type MessageAttachmentRecord = {
  attachments?: AttachmentInfo[] | null;
  fileAttachments?: StoredFileAttachment[] | null;
  pasteAttachments?: PasteAttachmentMeta[] | null;
  modelContent?: string | null;
};

/**
 * Make a user's filename safe to store, WITHOUT erasing their language.
 *
 * The class was `[^\w\s.\-()·]`, and JavaScript's `\w` is ASCII-only, so every
 * non-Latin filename was replaced with underscores:
 *
 *   "otchyot.pdf" in Cyrillic  -> "_____.pdf"
 *   Chinese two-character name -> "__.pdf"
 *   "Bericht_Uebersicht.pdf" with an umlaut -> "Bericht__bersicht.pdf"
 *
 * Unlike the session-title case this has nothing to do with model output — these
 * are the user's OWN files, so it has been mangling them for anyone not typing in
 * English, and the attachment chip showed them the damage every time.
 *
 * `\p{L}\p{N}\p{M}` with the `u` flag keeps letters, digits and combining marks in
 * any script. `\p{M}` matters: Devanagari and Arabic build characters from a
 * letter plus marks, so letters-only still breaks those filenames from the inside.
 *
 * THE SECURITY PROPERTY IS UNCHANGED, and that is the part to check when editing
 * this. Path separators, the Windows-reserved set and control characters are none
 * of L/N/M/space/dot/hyphen/paren/middot, so they are still replaced — a
 * traversal attempt still loses its separators and has nothing to traverse with.
 */
export function sanitizeAttachmentFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}\p{M}\s.\-()·]/gu, "_").slice(0, 120) || "attachment";
}

/** Browser + main-process safe stable hash (no node:crypto). */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function resolvePasteAttachmentId(paste: PasteAttachmentMeta): string {
  if (paste.id) return paste.id;
  const key = `${paste.kind}:${paste.displayName}:${paste.content}`;
  return `paste-${fnv1aHex(key)}${fnv1aHex(`${key}\0`)}`;
}

export function ensurePasteAttachmentIds(
  pastes: PasteAttachmentMeta[],
): PasteAttachmentMeta[] {
  // W2 (v14.8.11): ALWAYS the deterministic content-hash id — a randomUUID
  // branch here used to mint a fresh id on every rehydration, so after an
  // interrupted turn the model's previously announced attachmentId returned
  // "Attachment not found" on re-read. Same content ⟹ same id, forever.
  // Dedup by that id too: identical paste content is one attachment, so it's
  // never listed/injected twice (one directive line, one inline block).
  const seen = new Set<string>();
  const out: PasteAttachmentMeta[] = [];
  for (const paste of pastes) {
    const withId = paste.id
      ? paste
      : { ...paste, id: resolvePasteAttachmentId(paste) };
    if (seen.has(withId.id!)) continue;
    seen.add(withId.id!);
    out.push(withId);
  }
  return out;
}

export function pasteToAttachmentData(paste: PasteAttachmentMeta): AttachmentData {
  const id = resolvePasteAttachmentId(paste);
  const body =
    paste.kind === "terminal"
      ? (paste.displayContent ?? paste.content)
      : paste.content;
  const ext = paste.kind === "terminal" ? ".log" : ".txt";
  const filename = `${sanitizeAttachmentFilename(paste.displayName)}${ext}`;
  const data = encodeUtf8Base64(body);
  return {
    id,
    filename,
    mimeType: "text/plain",
    data,
    size: new TextEncoder().encode(body).length,
    addedAt: Date.now(),
  };
}

export function storedFileToAttachmentData(
  stored: StoredFileAttachment,
): AttachmentData {
  return {
    id: stored.id,
    filename: stored.filename,
    mimeType: stored.mimeType,
    data: stored.data,
    size: stored.size,
    addedAt: Date.now(),
  };
}

/** Upsert file + paste attachments into the in-process AttachmentStore,
 * tagged with the owning chat so other chats don't see them (v14.8.11). */
export function hydrateAttachmentStoreFromMessages(
  messages: MessageAttachmentRecord[],
  chatId?: number,
  sessionId?: string,
): void {
  for (const message of messages) {
    for (const file of message.fileAttachments ?? []) {
      AttachmentStore.add(storedFileToAttachmentData(file), chatId, sessionId);
    }
    for (const paste of message.pasteAttachments ?? []) {
      AttachmentStore.add(pasteToAttachmentData(paste), chatId, sessionId);
    }
  }
}

export function attachmentInfoFromStoredFile(
  stored: StoredFileAttachment,
): AttachmentInfo {
  return {
    id: stored.id,
    filename: stored.filename,
    mimeType: stored.mimeType,
    size: stored.size,
  };
}

export function buildPasteAttachmentDirective(
  pastes: PasteAttachmentMeta[] | undefined,
): string {
  if (!pastes?.length) return "";
  const lines = pastes.map((paste) => {
    const id = resolvePasteAttachmentId(paste);
    const kind = paste.kind === "terminal" ? "terminal" : "text";
    return `- name: "${paste.displayName}" | attachmentId: ${id} | kind: ${kind} | source: user-paste`;
  });
  return (
    "\n\nPASTED CONTENT ATTACHED (also inline in the user message; use read_attachment if needed):\n" +
    `${lines.join("\n")}\n`
  );
}
