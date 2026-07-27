/**
 * Atlarix Workspace Tools
 * =======================
 * Workspace lifecycle (create/list/switch), conversation utilities
 * (ask_user, compress_context, attachments).
 *
 * Absorbs: workspace-tools, compress-context-tool, attachment-tools,
 * and ask_user from execution-tools.
 */

import {
    ToolRegistry,
    createParameters,
    stringParam,
} from "./registry";




import path from "path";

import { extractTextFromPdfBuffer } from "@/lib/attachment-pdf-extract";
import { extractCsvFromBuffer } from "@/lib/attachment-csv-extract";
import {
    extractTextFromPptxBuffer,
    extractTextFromOdtBuffer,
} from "@/lib/attachment-office-xml-extract";
import { extractTextFromRtfBuffer } from "@/lib/attachment-rtf-extract";
import { SUPPORTED_TEXT_EXTENSIONS } from "@/lib/attachment-extensions";


import { estimateTokens } from "@/ipc/utils/token_utils";
import {
  runSteppedCompaction,
  getUsableBudget,
  countMessagesTokens,
} from "../context/compaction";
import { AttachmentStore, type AttachmentData } from "../attachment-store";
import log from "electron-log";
import { normalizeAskUserQuestions } from "./ask_user_options";
const logger = log.scope("workspace-tools");

ToolRegistry.register({
    name: "ask_user",
    description:
        "Ask the user one or more questions — YOUR TURN ENDS after asking. The user answers asynchronously and their answers arrive as the next user message, where you continue the task (or ask follow-ups). Because the turn ends, batch ALL questions you need into ONE call via `questions` (max 5, each with up to 4 `options`) — ask everything up front, never one at a time. A single `question` + `options` also works. The UI shows option buttons plus a free-text field per question.",
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            question: stringParam("Single question to ask the user (use `questions` to batch several)"),
            options: {
                type: "array",
                items: { type: "string" },
                description: "Optional: list of choices for the single question (preferred for multiple choice)",
            },
            choices: {
                type: "array",
                items: { type: "string" },
                description: "Optional: same as options (alias if the model uses this name)",
            },
            questions: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        question: { type: "string", description: "The question text" },
                        options: {
                            type: "array",
                            items: { type: "string" },
                            description: "Optional choices (up to 4)",
                        },
                    },
                    required: ["question"],
                },
                description:
                    "Batch of questions (max 5) to ask together — the user answers all before you continue. Preferred over multiple ask_user calls.",
            },
        },
        []
    ),
    handler: async (args) => {
        const questions = normalizeAskUserQuestions(args as Record<string, unknown>);
        if (questions.length === 0) {
            return { success: false, error: "ask_user requires `question` or a non-empty `questions` array." };
        }
        return {
            __ask_user: true as const,
            // Legacy single fields kept for compatibility with older paths.
            question: questions[0].question,
            ...(questions[0].options?.length ? { options: questions[0].options } : {}),
            questions,
        };
    },
});

// ═══════════════════════════════════════════════════════════
// COMPRESS CONTEXT
// ═══════════════════════════════════════════════════════════

export type ExecuteCompressContextContext = {
    chatId: number;
    messages: Array<{ id: number; role: string; content: string }>;
    systemPromptTokens: number;
    inputTokens?: number;
    providerId?: string;
    sessionStats?: { toolCallCount?: number; delegationCount?: number };
    /** Replaces the caller's live transcript (in-memory transport) after compaction. */
    setMessages: (next: Array<{ id: number; role: string; content: string }>) => void;
    /**
     * The stream's already-resolved workspace session id (req.workspaceSessionId).
     * Preferred over re-resolving from `chatId` (which can be negative/unbound for
     * the live transport and would silently fail to persist the compaction marker).
     */
    workspaceSessionId?: string | null;
};

/**
 * Durable copy of a compaction summary into the bound session so a reload (and the
 * dispatch funnel's `sliceFromLastCompactionSummary`) keeps the compact history.
 * Returns true when the `[COMPACTION MARKER]` row was actually written. Prefers the
 * caller-supplied `sessionId` (the stream's known-good `req.workspaceSessionId`)
 * over re-resolving from `chatId`.
 */
async function persistCompactionSummaryToSession(
    chatId: number,
    afterList: Array<{ role: string; content?: string | null }>,
    sessionId?: string | null,
): Promise<boolean> {
    try {
        const { isCompactionSummaryMessage } = await import("../context/compaction");
        const summaryMsg = afterList.find(
            (m) => m.role === "user" && isCompactionSummaryMessage(m.content),
        );
        if (!summaryMsg?.content) return false;
        const {
            resolveOrBindWorkspaceSessionForStream,
            persistWorkspaceSessionUserMessage,
        } = await import("@/ipc/handlers/workspace_session_handlers");
        const resolvedSessionId =
            sessionId ?? (await resolveOrBindWorkspaceSessionForStream({ chatId }));
        if (!resolvedSessionId) {
            logger.warn(
                `[compaction] No workspace session id to persist summary (chat ${chatId}); reopened session will not stay compacted.`,
            );
            return false;
        }
        await persistWorkspaceSessionUserMessage(resolvedSessionId, summaryMsg.content, {});
        logger.info(`[compaction] Summary persisted to session ${resolvedSessionId}`);
        return true;
    } catch (err) {
        logger.warn("[compaction] Could not persist summary to session:", err);
        return false;
    }
}

/**
 * v11.1 overflow recovery: aggressively compact an ephemeral chat's message
 * list after a provider context-overflow error. Bypasses the usage-ratio
 * gates by feeding an artificially low budget (the provider just told us the
 * real window is smaller than our estimate). Returns true when anything
 * was compacted (the retry dispatch then sees the smaller history).
 */
export async function forceCompactEphemeralChat(
    chatId: number,
    providerId?: string,
): Promise<boolean> {
    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const chat = getStreamTransport(chatId);
    if (!chat || chat.messages.length < 4) return false;

    const msgList = chat.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content ?? "",
    }));
    const currentTokens = msgList.reduce(
        (acc, m) => acc + estimateTokens(m.content || ""),
        0,
    );
    // Half the current size as the target forces prune + summarize.
    const forcedLimit = Math.max(8_000, Math.floor(currentTokens / 2));
    const stepped = await runSteppedCompaction(msgList, forcedLimit, providerId);
    if (!stepped.compactionApplied) return false;

    chat.messages = stepped.modelContext.map((m) => ({
        id: m.id,
        chatId,
        role: m.role as "user" | "assistant",
        content: m.content || "",
        createdAt: new Date(),
    }));
    if (stepped.strategy === "summarized") {
        await persistCompactionSummaryToSession(chatId, stepped.modelContext);
    }
    logger.info(
        `[compaction] Forced overflow compaction freed ~${stepped.tokensFreed} tokens (chat ${chatId})`,
    );
    return true;
}

export async function executeCompressContext(
    params: { reason?: string },
    ctx: ExecuteCompressContextContext,
): Promise<{
    success: boolean;
    reason: string;
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
    status: "completed" | "noop";
    /** True when the durable `[COMPACTION MARKER]` row was written to the session. */
    summaryPersisted: boolean;
    /** Which compaction strategy ran (only "summarized" persists a marker). */
    strategy: string;
    tokensFreed: number;
}> {
    const reason =
        typeof params.reason === "string" && params.reason.trim()
            ? params.reason.trim()
            : "model-initiated";

    const msgList = (ctx.messages ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content ?? "",
    }));
    const tokensBefore = countMessagesTokens(msgList);

    const tierLimit = await getUsableBudget(ctx.providerId);
    // W6 (v14.8.11): the model asked for space — force past the 60% usage
    // gate, and measure usage in the METER's scope (history + system prompt
    // + input) so the tool never reports "nothing to do" while the meter
    // shows a high fill. The old messages-only, gate-deferred call was a
    // guaranteed mid-turn no-op that models read as "tokens did not reduce".
    const stepped = await runSteppedCompaction(msgList, tierLimit, ctx.providerId, {
        force: true,
        alreadyUsedTokens: (ctx.systemPromptTokens ?? 0) + (ctx.inputTokens ?? 0),
    });
    const afterList = stepped.modelContext ?? msgList;
    const tokensAfter = countMessagesTokens(afterList);
    ctx.setMessages(afterList.map((m) => ({ id: m.id, role: m.role, content: m.content || "" })));
    // v11.1 durable compaction: persist the summary message to the bound
    // workspace session so reloads keep the compact model history (the
    // dispatch funnel slices from the last summary marker).
    let summaryPersisted = false;
    if (stepped.strategy === "summarized") {
        summaryPersisted = await persistCompactionSummaryToSession(
            ctx.chatId,
            afterList,
            ctx.workspaceSessionId,
        );
    }
    const applied = stepped.compactionApplied === true;
    return {
        success: applied,
        reason,
        tokensBefore,
        tokensAfter,
        summary: applied
            ? (stepped.summaryText ??
              `Context compressed: history ${tokensBefore} → ${tokensAfter} tokens (${stepped.strategy}).`)
            : `Already compact: history is ${tokensBefore} tokens (~${Math.round(
                  (tokensBefore / Math.max(tierLimit, 1)) * 100,
              )}% of the ${tierLimit}-token usable budget) — nothing worth compacting. No action needed.`,
        status: applied ? "completed" : "noop",
        summaryPersisted,
        strategy: stepped.strategy,
        tokensFreed: stepped.tokensFreed,
    };
}

ToolRegistry.register({
    name: "compress_context",
    requiresWorkspace: false,
    isReadOnly: true,
    allowInAskMode: true,
    isCore: true,
    description:
        "Summarize and compress older turns of this conversation into a session summary to free context. " +
        "Compaction is automatic — you are told explicitly when the session is near full, and your context window is stated in the system prompt. " +
        "Do NOT call this because the thread feels long: a long conversation is not a full one, and summarizing early destroys detail you still had room for. " +
        "Call it only after a fill warning, or immediately before deliberately adding something very large.",
    parameters: {
        type: "object",
        properties: {
            reason: {
                type: "string",
                description: "Brief reason (for the activity log).",
            },
        },
        required: [],
    },
    handler: async ({ reason }: { reason?: string }) => {
        return {
            __compress_context_requested: true,
            reason: typeof reason === "string" && reason.trim() ? reason.trim() : "model-initiated",
        };
    },
});

// ═══════════════════════════════════════════════════════════
// ATTACHMENTS (read_attachment, list_attachments)
// ═══════════════════════════════════════════════════════════


const SUPPORTED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico"];
const SUPPORTED_DOCUMENT_EXTENSIONS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".rtf"];

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

async function extractTextFromXlsx(buffer: Buffer): Promise<{
    text: string;
    sheets: number;
    rows: number;
    success: boolean;
    table: import("@/lib/attachment-csv-extract").CsvTableData | null;
    sheetName?: string;
}> {
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

        // Structured table from the first sheet for the renderer card.
        let table = null;
        const firstSheetName = workbook.SheetNames[0];
        const firstSheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
        if (firstSheet) {
            const matrix = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, {
                header: 1,
                raw: false,
                defval: "",
            }) as unknown as string[][];
            if (matrix.length > 0) {
                const MAX_ROWS = 200;
                const MAX_COLS = 50;
                const totalColumns = matrix.reduce((m, r) => Math.max(m, r.length), 0);
                table = {
                    headers: (matrix[0] ?? []).slice(0, MAX_COLS).map(String),
                    rows: matrix.slice(1, 1 + MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map(String)),
                    totalRows: matrix.length - 1,
                    totalColumns,
                    truncated: matrix.length - 1 > MAX_ROWS || totalColumns > MAX_COLS,
                };
            }
        }

        return {
            text: allText.trim(),
            sheets: workbook.SheetNames.length,
            rows: totalRows,
            success: Boolean(allText.trim().length > 0),
            table,
            sheetName: firstSheetName,
        };
    } catch (err) {
        logger.warn(`xlsx failed: ${err}`);
        return { text: "", sheets: 0, rows: 0, success: false, table: null };
    }
}

function extractStructuredData(attachment: AttachmentData): any {
    const ext = getFileExtension(attachment.filename);

    // CSV gets the structured spreadsheet path (table card in the renderer);
    // other text extensions keep the plain-text path below.
    if (ext === ".csv") {
        const buffer = Buffer.from(attachment.data, "base64");
        return extractCsvFromBuffer(buffer).then((result) => {
            if (result.success) {
                return {
                    type: "spreadsheet",
                    filename: attachment.filename,
                    size: attachment.size,
                    mimeType: "text/csv",
                    format: "csv",
                    content: result.text,
                    table: result.table,
                    rows: result.rowCount,
                    columns: result.columnCount,
                    charCount: result.text.length,
                    note: `CSV parsed: ${result.rowCount} row(s), ${result.columnCount} column(s).`,
                };
            }
            // Fall back to raw text so odd delimiters still surface something.
            const text = buffer.toString("utf-8");
            return {
                type: "text",
                filename: attachment.filename,
                size: attachment.size,
                content: text,
                lineCount: text.split("\n").length,
                charCount: text.length,
                note: "CSV table parsing failed; raw text provided.",
            };
        }) as any;
    }

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
            };
        }
    }

    if (isImageFile(ext)) {
        // SVG is XML — most providers reject image/svg+xml as image input, and
        // the markup is far more useful to the model as text anyway.
        if (ext === ".svg") {
            const text = Buffer.from(attachment.data, "base64").toString("utf-8");
            return {
                type: "text",
                filename: attachment.filename,
                size: attachment.size,
                content: text,
                lineCount: text.split("\n").length,
                charCount: text.length,
                note: "SVG returned as XML markup (providers do not accept SVG as image input).",
            };
        }
        const mimeTypes: Record<string, string> = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
            ".ico": "image/x-icon",
        };
        // W4 (v14.8.11): the SCREENSHOT shape — top-level success:true +
        // image mimeType + data. buildToolModelOutput detects it and sends a
        // real media part (with the vision gate + non-vision text fallback),
        // and maybeTruncateToolOutput exempts it from truncation. Previously
        // this returned a plain object that was JSON-stringified into
        // (truncation-corrupted) base64 text the model could never view.
        return {
            success: true,
            type: "image",
            filename: attachment.filename,
            size: attachment.size,
            mimeType: mimeTypes[ext] || "application/octet-stream",
            data: attachment.data,
            note: `User-attached image ${attachment.filename}`,
        };
    }

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

        if (ext === ".pdf") {
            if (attachment.pdfExtract) {
                logger.info(`read_attachment PDF cache hit: ${attachment.filename}`);
                const result = attachment.pdfExtract;
                return {
                    type: "document",
                    filename: attachment.filename,
                    size: attachment.size,
                    mimeType: mimeTypes[ext] || "application/octet-stream",
                    format: "pdf",
                    pages: result.pages,
                    content: result.text,
                    charCount: result.text.length,
                    cached: true,
                    success: result.success,
                };
            }
            const buffer = Buffer.from(attachment.data, "base64");
            return extractTextFromPdfBuffer(buffer).then((result) => {
                if (result.success) {
                    return {
                        type: "document",
                        filename: attachment.filename,
                        size: attachment.size,
                        mimeType: mimeTypes[ext] || "application/octet-stream",
                        content: result.text,
                        pages: result.pages,
                        charCount: result.text.length,
                        note: "PDF content extracted.",
                    };
                } else {
                    const errMsg =
                        result.text.startsWith("[PDF")
                            ? result.text
                            : "PDF text extraction failed. The PDF may be password-protected/encrypted or scanned/images-only.";
                    return {
                        success: false,
                        type: "document",
                        filename: attachment.filename,
                        size: attachment.size,
                        mimeType: mimeTypes[ext] || "application/octet-stream",
                        content: null,
                        error: errMsg,
                        suggestion:
                            "If the PDF is password-protected, ask the user to re-attach an unencrypted copy. If it is scanned/images-only, text extraction cannot recover it. Otherwise use list_attachments and try another file.",
                    };
                }
            }) as any;
        }

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
                        note: "Could not extract text from this Word document (corrupt or unsupported format?).",
                    };
                }
            }) as any;
        }

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
                        table: result.table,
                        sheetName: result.sheetName,
                        charCount: result.text.length,
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
                        note: "Could not extract text from this Excel file (corrupt or unsupported format?).",
                    };
                }
            }) as any;
        }

        if (ext === ".pptx") {
            const buffer = Buffer.from(attachment.data, "base64");
            const result = extractTextFromPptxBuffer(buffer);
            if (result.success) {
                return {
                    type: "presentation",
                    filename: attachment.filename,
                    size: attachment.size,
                    mimeType: mimeTypes[ext] || "application/octet-stream",
                    content: result.text,
                    slides: result.parts,
                    charCount: result.text.length,
                    note: `PowerPoint deck extracted: ${result.parts} slide(s).`,
                };
            }
            return {
                type: "presentation",
                filename: attachment.filename,
                size: attachment.size,
                mimeType: mimeTypes[ext] || "application/octet-stream",
                content: null,
                error: "PowerPoint text extraction failed (corrupt or password-protected deck?).",
                note: "Could not extract slide text (corrupt or password-protected deck?).",
            };
        }

        if (ext === ".odt") {
            const buffer = Buffer.from(attachment.data, "base64");
            const result = extractTextFromOdtBuffer(buffer);
            if (result.success) {
                return {
                    type: "document",
                    filename: attachment.filename,
                    size: attachment.size,
                    mimeType: "application/vnd.oasis.opendocument.text",
                    content: result.text,
                    charCount: result.text.length,
                    note: "OpenDocument text extracted successfully.",
                };
            }
            return {
                type: "document",
                filename: attachment.filename,
                size: attachment.size,
                mimeType: "application/vnd.oasis.opendocument.text",
                content: null,
                error: "OpenDocument text extraction failed.",
                note: "Could not extract text from this .odt file.",
            };
        }

        if (ext === ".rtf") {
            const buffer = Buffer.from(attachment.data, "base64");
            const result = extractTextFromRtfBuffer(buffer);
            if (result.success) {
                return {
                    type: "document",
                    filename: attachment.filename,
                    size: attachment.size,
                    mimeType: "application/rtf",
                    content: result.text,
                    charCount: result.text.length,
                    note: "RTF text extracted successfully.",
                };
            }
            return {
                type: "document",
                filename: attachment.filename,
                size: attachment.size,
                mimeType: "application/rtf",
                content: null,
                error: "RTF text extraction failed (not a valid RTF file?).",
                note: "Could not extract text from this RTF file.",
            };
        }

        return {
            type: "document",
            filename: attachment.filename,
            size: attachment.size,
            mimeType: mimeTypes[ext] || "application/octet-stream",
            content: null,
            note: `Legacy ${ext} format is not text-extractable. Ask the user to re-save it as ${ext === ".doc" ? ".docx" : ext === ".xls" ? ".xlsx" : ".pptx"} and re-attach.`,
        };
    }

    return {
        type: "binary",
        filename: attachment.filename,
        size: attachment.size,
        mimeType: "application/octet-stream",
        data: attachment.data,
    };
}

/**
 * v14.8.11 scoping: does this record belong to the calling chat? Untagged
 * records (legacy adds, sub-agent context) stay globally visible; when no
 * scope was injected (direct registry calls), everything is visible.
 */
function attachmentInScope(
    record: { chatIds?: number[]; sessionIds?: string[] },
    scopeChatId: unknown,
    scopeSessionId?: unknown,
): boolean {
    const hasChatScope = typeof scopeChatId === "number";
    const hasSessionScope = typeof scopeSessionId === "string" && scopeSessionId.length > 0;
    if (!hasChatScope && !hasSessionScope) return true;
    const tagged =
        (record.chatIds?.length ?? 0) > 0 || (record.sessionIds?.length ?? 0) > 0;
    if (!tagged) return true; // legacy/sub-agent adds stay globally visible
    // Session UUID is the primary key (stable across relaunches); the
    // transport chat id is a secondary match for records tagged pre-session.
    if (hasSessionScope && record.sessionIds?.includes(scopeSessionId as string)) return true;
    if (hasChatScope && record.chatIds?.includes(scopeChatId as number)) return true;
    return false;
}

// ── W3 (v14.8.11): read_attachment paging (read_file parity) ──────────────
// Extractors return FULL text; this pager bounds what reaches the model per
// call and the result always states how to fetch the rest — full content is
// reachable, never truncated ("guide via the result channel, never dead-end").
const READ_ATTACHMENT_DEFAULT_LINES = 2_000;
const READ_ATTACHMENT_MAX_LINES = 10_000;
const READ_ATTACHMENT_MAX_BYTES = 200_000;

function pageAttachmentText(
    full: string,
    offsetParam: unknown,
    limitParam: unknown,
): {
    content: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    totalChars: number;
    hasMore: boolean;
} {
    const lines = full.split("\n");
    const totalLines = lines.length;
    const startLine = Math.max(1, Math.floor(Number(offsetParam) || 1));
    const requested = Math.floor(Number(limitParam) || READ_ATTACHMENT_DEFAULT_LINES);
    const maxLines = Math.min(Math.max(1, requested), READ_ATTACHMENT_MAX_LINES);

    const pageLines: string[] = [];
    let bytes = 0;
    let end = startLine - 1; // exclusive index into `lines`
    while (end < totalLines && pageLines.length < maxLines) {
        const line = lines[end]!;
        const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
        if (pageLines.length > 0 && bytes + lineBytes > READ_ATTACHMENT_MAX_BYTES) break;
        pageLines.push(line);
        bytes += lineBytes;
        end++;
    }
    return {
        content: pageLines.join("\n"),
        startLine,
        endLine: end,
        totalLines,
        totalChars: full.length,
        hasMore: end < totalLines,
    };
}

ToolRegistry.register({
    name: "read_attachment",
    description:
        "Read and extract structured content from a file attachment. " +
        "Returns text content for documents and structured data for PDFs, Word (.docx), Excel (.xlsx), CSV, PowerPoint (.pptx), OpenDocument (.odt), and RTF files; image attachments are returned as a viewable image. " +
        "Large content is PAGED: each call returns up to `limit` lines starting at 1-based line `offset` (defaults cover most files), and the result states the total size and the exact next call to continue — the FULL content is always reachable, never truncated. " +
        "Call it whenever the user references an uploaded file or attachment.",
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true,
    allowInAskMode: true,
    parameters: createParameters(
        {
            attachmentId: stringParam(
                "The attachment ID to read. This is a unique identifier assigned when the file was uploaded."
            ),
            attachmentIds: {
                type: "array",
                items: { type: "string" },
                description:
                    "Optional batch of attachment IDs. Returns per-file results; one failure does not abort the rest.",
            },
            offset: {
                type: "number",
                description:
                    "1-based line number to start reading extracted text from (default 1). Use the next-page offset stated in a prior result to continue.",
            },
            limit: {
                type: "number",
                description: "Maximum lines to return for this page (default 2000).",
            },
        },
        []
    ),
    handler: async ({
        attachmentId,
        attachmentIds,
        offset,
        limit,
        _scopeChatId,
        _scopeSessionId,
    }: {
        attachmentId?: string;
        attachmentIds?: string[];
        offset?: number;
        limit?: number;
        /** Injected by the stream tool wrapper — never model-supplied. */
        _scopeChatId?: number;
        _scopeSessionId?: string;
    }) => {
        const ids = [
            ...(Array.isArray(attachmentIds) ? attachmentIds.filter((id) => typeof id === "string") : []),
            ...(typeof attachmentId === "string" && attachmentId ? [attachmentId] : []),
        ];
        const uniqueIds = [...new Set(ids)];

        if (uniqueIds.length === 0) {
            return {
                success: false,
                error: "Provide attachmentId or attachmentIds",
                suggestion: "Use list_attachments to see available attachment IDs.",
                partial: null,
            };
        }

        const readOne = async (id: string, inBatch = false) => {
            const attachment = AttachmentStore.get(id);
            if (!attachment || !attachmentInScope(attachment, _scopeChatId, _scopeSessionId)) {
                return {
                    name: id,
                    success: false as const,
                    error: `Attachment not found in this conversation: ${id}. It may have expired or belong to a different session.`,
                    suggestion: "Use list_attachments to see current IDs.",
                };
            }
            try {
                // W3: cache the full extraction on the record so paging never
                // re-parses (PDF/xlsx/docx parsing is the expensive part).
                let structuredData: Record<string, unknown>;
                if (attachment.extractCache) {
                    structuredData = attachment.extractCache;
                } else {
                    let extracted = extractStructuredData(attachment);
                    if (extracted && typeof extracted.then === "function") {
                        extracted = await extracted;
                    }
                    structuredData = extracted as Record<string, unknown>;
                    if (
                        structuredData &&
                        typeof structuredData === "object" &&
                        structuredData.success !== false &&
                        typeof structuredData.content === "string"
                    ) {
                        attachment.extractCache = structuredData;
                    }
                }
                const ok =
                    structuredData &&
                    typeof structuredData === "object" &&
                    (structuredData as { success?: boolean }).success !== false;

                // W4: image media is only detectable at the TOP level of the
                // tool result — nested inside a batch's results[] it would be
                // JSON-stringified (and its base64 truncation-corrupted).
                // Point the model at a single-id call instead.
                if (ok && inBatch && structuredData.type === "image" && structuredData.data) {
                    return {
                        name: attachment.filename,
                        success: true,
                        type: "image",
                        filename: attachment.filename,
                        size: attachment.size,
                        note: `Image attachment — to view it, call read_attachment({ "attachmentId": "${id}" }) alone (images cannot be delivered inside a batch result).`,
                    };
                }

                // W3: page string content (line-based, read_file parity). The
                // result always states totals + the exact next call, so the
                // full content is reachable — never a dead-end truncation.
                if (ok && typeof structuredData.content === "string") {
                    const page = pageAttachmentText(
                        structuredData.content,
                        offset,
                        limit,
                    );
                    const pageNote = page.hasMore
                        ? `Showing lines ${page.startLine}–${page.endLine} of ${page.totalLines} (${page.totalChars} chars total). For the next page call read_attachment({ "attachmentId": "${id}", "offset": ${page.endLine + 1} }).`
                        : page.startLine > 1
                          ? `Showing lines ${page.startLine}–${page.endLine} of ${page.totalLines} (end of content).`
                          : undefined;
                    structuredData = {
                        ...structuredData,
                        content: page.content,
                        totalLines: page.totalLines,
                        totalChars: page.totalChars,
                        startLine: page.startLine,
                        endLine: page.endLine,
                        ...(page.hasMore ? { hasMore: true } : {}),
                        // The renderer table card only makes sense on page 1.
                        ...(page.startLine > 1 ? { table: undefined } : {}),
                        ...(pageNote
                            ? {
                                  note: [structuredData.note, pageNote]
                                      .filter(Boolean)
                                      .join(" "),
                              }
                            : {}),
                    };
                }
                return {
                    name: attachment.filename,
                    success: ok,
                    ...structuredData,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    name: attachment.filename,
                    success: false as const,
                    error: `Failed to process attachment: ${msg}`,
                    suggestion: "Try list_attachments or re-upload the file.",
                };
            }
        };

        if (uniqueIds.length === 1) {
            logger.log(`read_attachment called with id: ${uniqueIds[0]}`);
            const one = await readOne(uniqueIds[0]);
            if (!one.success) {
                return {
                    success: false,
                    error: one.error,
                    suggestion: one.suggestion,
                    partial: null,
                    filename: one.name,
                    availableAttachments:
                        "error" in one && one.error?.includes("not found")
                            ? AttachmentStore.getAll()
                                  .filter((a) => attachmentInScope(a, _scopeChatId, _scopeSessionId))
                                  .map((a) => ({
                                      id: a.id,
                                      filename: a.filename,
                                      size: a.size,
                                  }))
                            : undefined,
                    ...(one as Record<string, unknown>),
                };
            }
            return { ...one, success: true };
        }

        const results = await Promise.all(uniqueIds.map((id) => readOne(id, true)));
        const allOk = results.every((r) => r.success);
        return {
            success: allOk,
            partial: allOk ? null : results.filter((r) => !r.success),
            results,
            suggestion: allOk
                ? undefined
                : "Some attachments failed; read successful entries from results and retry failed IDs individually.",
        };
    },
});

ToolRegistry.register({
    name: "list_attachments",
    description:
        "List all available file attachments in the current conversation. " +
        "This tool is available in Ask, Plan, Build, Debug, and Review modes. " +
        "Call it whenever the user references an uploaded file or attachment. " +
        "Use this to find the ID of an attachment you want to read with read_attachment.",
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true,
    allowInAskMode: true,
    parameters: createParameters({}, []),
    handler: async ({
        _scopeChatId,
        _scopeSessionId,
    }: { _scopeChatId?: number; _scopeSessionId?: string } = {}) => {
        // v14.8.11: scoped to the calling chat/session — the store is
        // process-global, so unscoped listing leaked other sessions'
        // attachments into every conversation.
        const attachments = AttachmentStore.getAll().filter((a) =>
            attachmentInScope(a, _scopeChatId, _scopeSessionId),
        );

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
