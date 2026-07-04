/**
 * Attachment Store
 * ================
 * In-memory store for attachment data, used by the read_attachment tool
 * to extract structured content from uploaded files.
 */

import log from "electron-log";
import { isMainProcessNode } from "@/lib/runtime/is-main-node";
import type { PdfExtractResult } from "@/lib/attachment-pdf-extract";

const logger = isMainProcessNode() ? log.scope("attachment-store") : null;

export interface AttachmentData {
    id: string;
    filename: string;
    mimeType: string;
    data: string; // base64 encoded
    size: number;
    addedAt: number;
    /** Set when PDF text is pre-extracted on upload. */
    pdfExtract?: PdfExtractResult;
    /**
     * W3 (v14.8.11): full structured extraction, cached after the first
     * read_attachment call so paging (offset/limit) never re-parses the
     * document. Holds the resolved extractStructuredData result.
     */
    extractCache?: Record<string, unknown>;
    /**
     * v14.8.11 scoping: chats this attachment belongs to. The store is one
     * process-global map, so without this, list/read_attachment leaked every
     * hydrated session's attachments into every chat (observed live: a
     * 2-attachment message listed 6, four of them another session's pastes).
     * Untagged records (legacy/sub-agent adds) stay globally visible.
     */
    chatIds?: number[];
    /**
     * Session UUIDs this attachment belongs to — the PRIMARY scope key.
     * Transport chat ids are remade on every app relaunch, so a record
     * hydrated under an old transport id became invisible to the live chat
     * (observed: an edited first message listed ZERO attachments). Session
     * ids are stable forever.
     */
    sessionIds?: string[];
}

class AttachmentStoreImpl {
    private attachments: Map<string, AttachmentData> = new Map();

    add(attachment: AttachmentData, chatId?: number, sessionId?: string): string {
        const existing = this.attachments.get(attachment.id);
        const chatIds = new Set<number>([
            ...(existing?.chatIds ?? []),
            ...(attachment.chatIds ?? []),
            ...(chatId != null ? [chatId] : []),
        ]);
        const sessionIds = new Set<string>([
            ...(existing?.sessionIds ?? []),
            ...(attachment.sessionIds ?? []),
            ...(sessionId ? [sessionId] : []),
        ]);
        const record: AttachmentData = {
            ...existing,
            ...attachment,
            // Never lose an existing extraction/pre-extract on a re-add.
            extractCache: attachment.extractCache ?? existing?.extractCache,
            pdfExtract: attachment.pdfExtract ?? existing?.pdfExtract,
            ...(chatIds.size > 0 ? { chatIds: [...chatIds] } : {}),
            ...(sessionIds.size > 0 ? { sessionIds: [...sessionIds] } : {}),
        };
        this.attachments.set(record.id, record);
        logger?.log(
            `Stored attachment: ${record.id} (${record.filename}, ${record.size} bytes${chatIds.size ? `, chats: ${[...chatIds].join(",")}` : ""})`,
        );
        return record.id;
    }

    get(id: string): AttachmentData | undefined {
        return this.attachments.get(id);
    }

    remove(id: string): boolean {
        const deleted = this.attachments.delete(id);
        if (deleted) {
            logger?.log(`Removed attachment: ${id}`);
        }
        return deleted;
    }

    clear(): void {
        this.attachments.clear();
        logger?.log("Cleared all attachments");
    }

    has(id: string): boolean {
        return this.attachments.has(id);
    }

    getAll(): AttachmentData[] {
        return Array.from(this.attachments.values());
    }
}

export const AttachmentStore = new AttachmentStoreImpl();
