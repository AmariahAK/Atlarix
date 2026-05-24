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
}

class AttachmentStoreImpl {
    private attachments: Map<string, AttachmentData> = new Map();

    add(attachment: AttachmentData): string {
        this.attachments.set(attachment.id, attachment);
        logger?.log(
            `Stored attachment: ${attachment.id} (${attachment.filename}, ${attachment.size} bytes)`,
        );
        return attachment.id;
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
