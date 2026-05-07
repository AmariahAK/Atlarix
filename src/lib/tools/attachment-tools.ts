/**
 * Atlarix Attachment Tools
 * =======================
 * Tools for reading and extracting content from file attachments
 */

import { ToolRegistry, ToolCategory, createParameters, stringParam } from "./registry";
import { AttachmentStore, type AttachmentData } from "../attachment-store";
import log from "electron-log";
import * as path from "node:path";

const logger = log.scope("attachment-tools");

const SUPPORTED_TEXT_EXTENSIONS = [
    ".md", ".txt", ".json", ".csv", ".js", ".ts", ".tsx", ".jsx",
    ".html", ".css", ".py", ".yaml", ".yml", ".xml", ".sh", ".bash",
    ".zsh", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".cs",
    ".rb", ".php", ".sql", ".graphql", ".env", ".gitignore", ".eslintrc",
    ".prettierrc", ".mdx", ".rst", ".log", ".toml", ".ini", ".cfg",
];

const SUPPORTED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico"];
const SUPPORTED_DOCUMENT_EXTENSIONS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"];

function getFileExtension(filename: string): string {
    return path.extname(filename).toLowerCase();
}

function isTextFile(ext: string): boolean {
    return SUPPORTED_TEXT_EXTENSIONS.includes(ext);
}

function isImageFile(ext: string): boolean {
    return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
}

function isDocumentFile(ext: string): boolean {
    return SUPPORTED_DOCUMENT_EXTENSIONS.includes(ext);
}

async function extractTextFromPdf(buffer: Buffer): Promise<{ text: string; pages: number; success: boolean }> {
    // Fast-path extraction via pdf-parse (quick, but brittle on some modern PDFs).
    try {
        const pdfParseModule = await import("pdf-parse");
        const pdfParse = pdfParseModule.default;
        const data = await pdfParse(buffer);
        const text = data.text || "";
        const pages = data.numpages || 0;
        if (text && text.trim().length > 0) {
            return {
                text,
                pages,
                success: true,
            };
        }
    } catch (err) {
        logger.warn(`pdf-parse failed: ${err}`);
    }

    // Fallback extraction via pdfjs-dist (more robust for many PDFs).
    try {
        // pdfjs-dist ships multiple builds; prefer legacy/build for Node usage.
        // We use dynamic import so this file remains loadable even if the dependency is missing.
        const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");

        const getDocument = pdfjs.getDocument ?? pdfjs.default?.getDocument;
        if (typeof getDocument !== "function") {
            throw new Error("pdfjs-dist getDocument not found");
        }

        const loadingTask = getDocument({
            data: new Uint8Array(buffer),
            // Prevent worker setup in Node/Electron main.
            disableWorker: true,
            // Avoid font-face/DOM related paths.
            useSystemFonts: true,
        });

        const doc = await loadingTask.promise;
        const numPages = doc.numPages ?? 0;
        const pageTexts: string[] = [];

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            const page = await doc.getPage(pageNum);
            const content = await page.getTextContent();
            const items: any[] = Array.isArray(content?.items) ? content.items : [];
            const line = items
                .map((it) => (typeof it?.str === "string" ? it.str : ""))
                .filter(Boolean)
                .join(" ");
            if (line.trim()) pageTexts.push(line);
        }

        const text = pageTexts.join("\n\n").trim();
        return {
            text,
            pages: numPages,
            success: Boolean(text),
        };
    } catch (err: any) {
        const msg = String(err?.message ?? err ?? "");
        // Common pdfjs-dist error class for password-protected PDFs.
        const name = String(err?.name ?? "");
        if (name === "PasswordException" || /password/i.test(msg) || /encrypted/i.test(msg)) {
            // Treat as a clean failure; caller will surface an actionable message.
            logger.warn(`pdfjs-dist failed (encrypted/password?): ${msg}`);
            return { text: "", pages: 0, success: false };
        }
        logger.warn(`pdfjs-dist failed: ${msg}`);
        return { text: "", pages: 0, success: false };
    }
}

async function extractTextFromDocx(buffer: Buffer): Promise<{ text: string; paragraphs: number; success: boolean }> {
    try {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer });
        return {
            text: result.value || "",
            paragraphs: result.value ? result.value.split("\n\n").length : 0,
            success: Boolean(result.value && result.value.trim().length > 0),
        };
    } catch (err) {
        logger.warn(`mammoth failed: ${err}`);
        return { text: "", paragraphs: 0, success: false };
    }
}

async function extractTextFromXlsx(buffer: Buffer): Promise<{ text: string; sheets: number; rows: number; success: boolean }> {
    try {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(buffer, { type: "buffer" });
        let allText = "";
        let totalRows = 0;

        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const csv = XLSX.utils.sheet_to_csv(sheet);
            allText += `[Sheet: ${sheetName}]\n${csv}\n\n`;
            const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
            totalRows += range.e.r - range.s.r + 1;
        }

        return {
            text: allText.trim(),
            sheets: workbook.SheetNames.length,
            rows: totalRows,
            success: Boolean(allText.trim().length > 0),
        };
    } catch (err) {
        logger.warn(`xlsx failed: ${err}`);
        return { text: "", sheets: 0, rows: 0, success: false };
    }
}

function extractStructuredData(attachment: AttachmentData): any {
    const ext = getFileExtension(attachment.filename);

    // Text files - read as UTF-8
    if (isTextFile(ext)) {
        try {
            const buffer = Buffer.from(attachment.data, "base64");
            const text = buffer.toString("utf-8");
            return {
                type: "text",
                filename: attachment.filename,
                size: attachment.size,
                content: text,
                lineCount: text.split("\n").length,
                charCount: text.length,
            };
        } catch (err) {
            logger.warn(`Failed to parse text file ${attachment.filename}:`, err);
            return {
                type: "text",
                filename: attachment.filename,
                size: attachment.size,
                content: null,
                error: `Failed to decode text content: ${err}`,
                rawBase64: attachment.data,
            };
        }
    }

    // Images - return metadata and base64
    if (isImageFile(ext)) {
        const mimeTypes: Record<string, string> = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
            ".bmp": "image/bmp",
            ".ico": "image/x-icon",
        };
        return {
            type: "image",
            filename: attachment.filename,
            size: attachment.size,
            mimeType: mimeTypes[ext] || "application/octet-stream",
            data: attachment.data, // base64
            dimensions: null, // Would need image parsing library to extract
        };
    }

    // Documents (PDF, Word, Excel, etc.)
    if (isDocumentFile(ext)) {
        const mimeTypes: Record<string, string> = {
            ".pdf": "application/pdf",
            ".doc": "application/msword",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xls": "application/vnd.ms-excel",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".ppt": "application/vnd.ms-powerpoint",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        };

        // PDF extraction with pdf-parse
        if (ext === ".pdf") {
            const buffer = Buffer.from(attachment.data, "base64");
            return extractTextFromPdf(buffer).then((result) => {
                if (result.success) {
                    const MAX_CHARS = 200_000;
                    const clipped = result.text.length > MAX_CHARS;
                    const clippedText = clipped ? result.text.slice(0, MAX_CHARS) : result.text;
                    return {
                        type: "document",
                        filename: attachment.filename,
                        size: attachment.size,
                        mimeType: mimeTypes[ext] || "application/octet-stream",
                        content: clippedText,
                        pages: result.pages,
                        charCount: result.text.length,
                        rawBase64: attachment.data,
                        note: clipped
                            ? `PDF text extracted (truncated to first ${MAX_CHARS.toLocaleString()} chars). Raw base64 also available for OCR if needed.`
                            : "Full PDF content extracted. Raw base64 also available for OCR if needed.",
                    };
                } else {
                    return {
                        type: "document",
                        filename: attachment.filename,
                        size: attachment.size,
                        mimeType: mimeTypes[ext] || "application/octet-stream",
                        content: null,
                        error:
                            "PDF text extraction failed. The PDF may be password-protected/encrypted or scanned/images-only.",
                        rawBase64: attachment.data,
                        note:
                            "If this PDF is password-protected, export an unencrypted copy and re-attach. If it is scanned, base64 is provided for OCR.",
                    };
                }
            }) as any;
        }

        // Word (.docx) extraction with mammoth
        if (ext === ".docx") {
            const buffer = Buffer.from(attachment.data, "base64");
            return extractTextFromDocx(buffer).then((result) => {
                if (result.success) {
                    return {
                        type: "document",
                        filename: attachment.filename,
                        size: attachment.size,
                        mimeType: mimeTypes[ext] || "application/octet-stream",
                        content: result.text,
                        paragraphs: result.paragraphs,
                        charCount: result.text.length,
                        rawBase64: attachment.data,
                        note: "Word document content extracted successfully.",
                    };
                } else {
                    return {
                        type: "document",
                        filename: attachment.filename,
                        size: attachment.size,
                        mimeType: mimeTypes[ext] || "application/octet-stream",
                        content: null,
                        error: "Word document text extraction failed.",
                        rawBase64: attachment.data,
                        note: "Could not extract text from Word document. Base64 provided.",
                    };
                }
            }) as any;
        }

        // Excel (.xlsx) extraction with xlsx
        if (ext === ".xlsx") {
            const buffer = Buffer.from(attachment.data, "base64");
            return extractTextFromXlsx(buffer).then((result) => {
                if (result.success) {
                    return {
                        type: "spreadsheet",
                        filename: attachment.filename,
                        size: attachment.size,
                        mimeType: mimeTypes[ext] || "application/octet-stream",
                        content: result.text,
                        sheets: result.sheets,
                        rows: result.rows,
                        charCount: result.text.length,
                        rawBase64: attachment.data,
                        note: `Excel spreadsheet extracted: ${result.sheets} sheet(s), ${result.rows} row(s).`,
                    };
                } else {
                    return {
                        type: "spreadsheet",
                        filename: attachment.filename,
                        size: attachment.size,
                        mimeType: mimeTypes[ext] || "application/octet-stream",
                        content: null,
                        error: "Excel spreadsheet text extraction failed.",
                        rawBase64: attachment.data,
                        note: "Could not extract text from Excel file. Base64 provided.",
                    };
                }
            }) as any;
        }

        // For other documents (doc, xls, ppt, pptx), return base64 for now
        return {
            type: "document",
            filename: attachment.filename,
            size: attachment.size,
            mimeType: mimeTypes[ext] || "application/octet-stream",
            content: null,
            note: `${ext} content available as base64. Consider converting to .docx/.xlsx for better extraction.`,
            rawBase64: attachment.data,
        };
    }

    // Unknown file type - return as binary
    return {
        type: "binary",
        filename: attachment.filename,
        size: attachment.size,
        mimeType: "application/octet-stream",
        data: attachment.data, // base64
    };
}

// Register the read_attachment tool
ToolRegistry.register({
    name: "read_attachment",
    description:
        "Read and extract structured content from a file attachment. " +
        "Returns text content for documents, metadata for images, and structured data for PDFs/Word/Excel. " +
        "Use this when you need to analyze or process files the user has attached to the conversation. " +
        "If content extraction fails, check rawBase64 for the original file data.",
    category: ToolCategory.FILE,
    cost: 0,
    requiresWorkspace: false, // Works in both workspace and chat-only modes
    isCore: true,
    isReadOnly: true,
    allowInAskMode: true,
    parameters: createParameters(
        {
            attachmentId: stringParam(
                "The attachment ID to read. This is a unique identifier assigned when the file was uploaded."
            ),
        },
        ["attachmentId"]
    ),
    handler: async ({ attachmentId }: { attachmentId: string }) => {
        logger.log(`read_attachment called with id: ${attachmentId}`);

        if (!attachmentId || typeof attachmentId !== "string") {
            return {
                success: false,
                error: "attachmentId is required and must be a string",
            };
        }

        const attachment = AttachmentStore.get(attachmentId);

        if (!attachment) {
            logger.warn(`Attachment not found: ${attachmentId}`);
            return {
                success: false,
                error: `Attachment not found: ${attachmentId}. The attachment may have expired or been cleared.`,
                availableAttachments: AttachmentStore.getAll().map((a) => ({
                    id: a.id,
                    filename: a.filename,
                    size: a.size,
                })),
            };
        }

        try {
            let structuredData = extractStructuredData(attachment);

            // Handle async extraction for PDF/Word/Excel
            if (structuredData && typeof structuredData.then === "function") {
                structuredData = await structuredData;
            }

            logger.log(`Successfully extracted data from ${attachment.filename}`);

            return {
                success: true,
                ...structuredData,
            };
        } catch (err) {
            logger.error(`Failed to extract data from ${attachment.filename}:`, err);
            return {
                success: false,
                error: `Failed to process attachment: ${err}`,
                filename: attachment.filename,
                rawBase64: attachment.data,
            };
        }
    },
});

// Register list_attachments tool (helper to see available attachments)
ToolRegistry.register({
    name: "list_attachments",
    description:
        "List all available file attachments in the current conversation. " +
        "Use this to find the ID of an attachment you want to read with read_attachment.",
    category: ToolCategory.FILE,
    cost: 0,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true,
    allowInAskMode: true,
    parameters: createParameters({}, []),
    handler: async () => {
        const attachments = AttachmentStore.getAll();

        return {
            success: true,
            count: attachments.length,
            attachments: attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
                addedAt: new Date(a.addedAt).toISOString(),
            })),
        };
    },
});