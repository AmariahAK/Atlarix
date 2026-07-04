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

function sanitizeAttachmentFilename(name: string): string {
  return name.replace(/[^\w\s.\-()·]/g, "_").slice(0, 120) || "attachment";
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
  return pastes.map((paste) =>
    paste.id ? paste : { ...paste, id: resolvePasteAttachmentId(paste) },
  );
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

/** Upsert file + paste attachments into the in-process AttachmentStore. */
export function hydrateAttachmentStoreFromMessages(
  messages: MessageAttachmentRecord[],
): void {
  for (const message of messages) {
    for (const file of message.fileAttachments ?? []) {
      AttachmentStore.add(storedFileToAttachmentData(file));
    }
    for (const paste of message.pasteAttachments ?? []) {
      AttachmentStore.add(pasteToAttachmentData(paste));
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
