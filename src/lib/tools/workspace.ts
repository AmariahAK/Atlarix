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
    ToolCategory,
    createParameters,
    stringParam,
} from "./registry";
import { generateCuteAppName } from "../utils";
import { db } from "../../db";
import { apps, chats } from "../../db/schema";
import { eq } from "drizzle-orm";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "node:os";
import { existsSync } from "node:fs";
import fs from "fs/promises";
import { SubscriptionManager } from "../SubscriptionManager";
import { estimateTokens } from "@/ipc/utils/token_utils";
import { runSteppedCompaction } from "../context/compaction";
import { runCompaction, type CompactionRunOutcome, getUsableBudget } from "../context-compaction";
import { AttachmentStore, type AttachmentData } from "../attachment-store";
import log from "electron-log";
import { ENV_SECRET_BLOCK_MESSAGE, isBlockedSecretBasename } from "@/lib/security/env-secret-paths";

const execAsync = promisify(exec);
const logger = log.scope("workspace-tools");

const DEFAULT_WORKSPACE_BASE = path.join(os.homedir(), "Documents", "Atlarix");

// ═══════════════════════════════════════════════════════════
// CREATE WORKSPACE
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "create_workspace",
    category: ToolCategory.FILE,
    description: "Create a new workspace (project folder) for building an app. Returns workspace ID and path. Prefer target_path (absolute) for user-chosen project root; otherwise uses ~/Documents/Atlarix/{name}.",
    cost: 5,
    requiresWorkspace: false,
    isCore: true,
    parameters: {
        project_name: {
            type: "string",
            description: "Optional: Project name (will generate cute name if not provided)",
            required: false,
        },
        description: {
            type: "string",
            description: "Brief description of what this workspace is for",
            required: false,
        },
        target_path: {
            type: "string",
            description: "Optional: Absolute path for project root. When set, workspace is created there; otherwise ~/Documents/Atlarix/{name}.",
            required: false,
        },
    },
    handler: async (params: {
        project_name?: string;
        description?: string;
        target_path?: string;
        chatId?: number;
    }) => {
        try {
            const workspaceLimitCheck = await SubscriptionManager.canCreateWorkspace();

            if (!workspaceLimitCheck.allowed) {
                const currentWorkspace = await SubscriptionManager.getCurrentWorkspaceDetails();

                return {
                    __permission_required: true,
                    operation: 'upgrade_required',
                    limit_type: 'workspace',
                    current_count: workspaceLimitCheck.currentCount,
                    max_allowed: workspaceLimitCheck.maxAllowed,
                    current_workspace: currentWorkspace,
                    reason: workspaceLimitCheck.reason,
                    upgrade_message: `Free tier includes 1 workspace with all features.

Your current workspace: "${currentWorkspace?.name || 'Unknown'}"
• ${currentWorkspace?.diagramCount || 0} diagrams saved

To create a new workspace, you can:
1. Delete your current workspace (loses data)
2. Upgrade to Pro ($19/mo) for unlimited workspaces

Would you like to upgrade or delete the existing workspace?`,
                };
            }

            const projectName = params.project_name || generateCuteAppName();

            const rawTarget = params.target_path?.trim();
            const useTargetPath = rawTarget && path.isAbsolute(rawTarget);
            const projectPath = useTargetPath
                ? path.resolve(rawTarget!)
                : path.join(DEFAULT_WORKSPACE_BASE, projectName);

            const [app] = await db
                .insert(apps)
                .values({
                    name: projectName,
                    path: projectPath,
                })
                .returning();

            SubscriptionManager.clearWorkspaceCache();

            await fs.mkdir(projectPath, { recursive: true });

            await execAsync("git init", { cwd: projectPath });
            await execAsync("git config user.email 'atlarix@ai.dev'", { cwd: projectPath });
            await execAsync("git config user.name 'Atlarix AI'", { cwd: projectPath });

            const readmeContent = `# ${projectName}\n\n${params.description || "Created with Atlarix AI"}\n`;
            await fs.writeFile(
                path.join(projectPath, "README.md"),
                readmeContent,
                "utf-8"
            );

            await execAsync("git add .", { cwd: projectPath });
            await execAsync('git commit -m "Init Atlarix app"', {
                cwd: projectPath,
            });

            if (params.chatId) {
                await db
                    .update(chats)
                    .set({ appId: app.id })
                    .where(eq(chats.id, params.chatId));
            }

            return {
                success: true,
                workspace_id: app.id,
                workspace_name: app.name,
                workspace_path: projectPath,
                message: `Created workspace "${projectName}"

Now you can:
- Call apply_template() to use a starter template
- Call write_file() to create files from scratch
- Call git_status() to check repository state

What would you like to build?`,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// LIST WORKSPACES
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "list_workspaces",
    category: ToolCategory.FILE,
    description: "List all workspaces (projects) the user has created",
    cost: 1,
    requiresWorkspace: false,
    isCore: true,
    parameters: {},
    handler: async () => {
        try {
            const allApps = await db.query.apps.findMany({
                orderBy: (apps, { desc }) => [desc(apps.createdAt)],
            });

            if (allApps.length === 0) {
                return {
                    success: true,
                    workspaces: [],
                    message: "No workspaces yet. Call create_workspace() to start building!",
                };
            }

            return {
                success: true,
                workspaces: allApps.map((app) => ({
                    id: app.id,
                    name: app.name,
                    path: app.path,
                    created: app.createdAt,
                })),
                total: allApps.length,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// SWITCH WORKSPACE
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "switch_workspace",
    category: ToolCategory.FILE,
    description: "Switch current chat to a different workspace",
    cost: 1,
    requiresWorkspace: false,
    isCore: true,
    parameters: {
        workspace_id: {
            type: "number",
            description: "Workspace ID to switch to",
            required: true,
        },
    },
    handler: async (params: { workspace_id: number; chatId?: number }) => {
        try {
            if (!params.chatId) {
                return {
                    success: false,
                    error: "No active chat to switch",
                };
            }

            const workspace = await db.query.apps.findFirst({
                where: (apps, { eq }) => eq(apps.id, params.workspace_id),
            });

            if (!workspace) {
                return {
                    success: false,
                    error: `Workspace ${params.workspace_id} not found`,
                };
            }

            await db
                .update(chats)
                .set({ appId: params.workspace_id })
                .where(eq(chats.id, params.chatId));

            return {
                success: true,
                workspace_id: workspace.id,
                workspace_name: workspace.name,
                message: `Switched to workspace "${workspace.name}"`,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// ASK USER (moved from execution-tools)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "ask_user",
    description:
        "Ask the user a question and wait for their response. Use for clarifications or choices. Pass `options` (string array) for multiple-choice; the app shows buttons plus a text field.",
    category: ToolCategory.EXECUTION,
    cost: 0,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            question: stringParam("Question to ask the user"),
            options: {
                type: "array",
                items: { type: "string" },
                description: "Optional: List of choices for the user",
            },
        },
        ["question"]
    ),
    handler: async ({ question, options }) => {
        return {
            __ask_user: true as const,
            question: String(question ?? ""),
            options: Array.isArray(options) ? options.map((o: string) => String(o)) : undefined,
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
    turnId?: string | null;
    /**
     * When true, use in-memory compaction (no DB writes) and optionally update the caller's
     * transcript via setMessages.
     */
    ephemeral?: boolean;
    setMessages?: (next: Array<{ id: number; role: string; content: string }>) => void;
};

export async function executeCompressContext(
    params: { reason?: string },
    ctx: ExecuteCompressContextContext,
): Promise<{
    success: boolean;
    reason: string;
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
    status: CompactionRunOutcome["status"];
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
    const tokensBefore = msgList.reduce((acc, m) => acc + estimateTokens(m.content || ""), 0);

    if (ctx.ephemeral === true || ctx.chatId < 0) {
        const tierLimit = getUsableBudget(ctx.providerId);
        const stepped = await runSteppedCompaction(msgList, tierLimit, ctx.providerId);
        const afterList = stepped.modelContext ?? msgList;
        const tokensAfter = afterList.reduce((acc, m) => acc + estimateTokens(m.content || ""), 0);
        if (ctx.setMessages) {
            ctx.setMessages(afterList.map((m) => ({ id: m.id, role: m.role, content: m.content || "" })));
        }
        return {
            success: stepped.compactionApplied === true,
            reason,
            tokensBefore,
            tokensAfter,
            summary: stepped.summaryText ?? "Context compressed.",
            status: stepped.compactionApplied === true ? "completed" : "noop",
        };
    }

    const compactionResult = await runCompaction({
        chatId: ctx.chatId,
        chatMessages: msgList,
        systemPromptTokens: ctx.systemPromptTokens,
        inputTokens: ctx.inputTokens ?? 0,
        providerId: ctx.providerId,
        sessionStats: ctx.sessionStats,
        turnId: ctx.turnId ?? null,
    });
    const afterList = compactionResult.status === "completed" ? compactionResult.messagesAfterSummary : msgList;
    const tokensAfter = afterList.reduce((acc, m) => acc + estimateTokens(m.content || ""), 0);

    return {
        success: compactionResult.status === "completed",
        reason,
        tokensBefore,
        tokensAfter,
        summary:
            compactionResult.status === "completed"
                ? compactionResult.summaryText
                : `No compaction performed: ${compactionResult.reason}`,
        status: compactionResult.status,
    };
}

ToolRegistry.register({
    name: "compress_context",
    requiresWorkspace: false,
    isReadOnly: true,
    allowInAskMode: true,
    category: ToolCategory.ANALYSIS,
    cost: 0,
    description:
        "Compress older completed parts of this conversation to free up context. " +
        "Call only when context pressure is real (after a finished subtask, long history, near the limit) — not preemptively.",
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

/**
 * PDF text extraction via pdfjs-dist legacy build, bundled into the main process (see vite.main.config).
 */
async function extractTextFromPdf(buffer: Buffer): Promise<{ text: string; pages: number; success: boolean }> {
    try {
        const { pathToFileURL } = await import("node:url");
        const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");

        let standardFontDataUrl: string | undefined;
        try {
            const { createRequire } = await import("node:module");
            const req = createRequire(import.meta.url);
            if (pdfjs?.GlobalWorkerOptions) {
                try {
                    const workerPath = req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
                    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
                } catch {
                    const workerPath = req.resolve("pdfjs-dist/build/pdf.worker.mjs");
                    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
                }
            }
            const fontPath = req.resolve("pdfjs-dist/standard_fonts/FoxitFixed.pbf");
            const fontsDir = path.dirname(fontPath);
            if (existsSync(path.join(fontsDir, "FoxitFixed.pfb"))) {
                standardFontDataUrl = pathToFileURL(`${fontsDir}${path.sep}`).toString();
            }
        } catch {
            /* Bundled prod: package tree may be absent; useSystemFonts covers typical PDFs. */
        }

        logger.info("[pdfjs] using bundled pdfjs-dist/legacy/build/pdf.mjs");

        const getDocument = pdfjs.getDocument ?? pdfjs.default?.getDocument;
        if (typeof getDocument !== "function") {
            throw new Error("pdfjs-dist getDocument not found");
        }

        const loadingTask = getDocument({
            data: new Uint8Array(buffer),
            disableWorker: true,
            useSystemFonts: true,
            ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
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
        const name = String(err?.name ?? "");
        if (name === "PasswordException" || /password/i.test(msg) || /encrypted/i.test(msg)) {
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
            data: attachment.data,
            dimensions: null,
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

    return {
        type: "binary",
        filename: attachment.filename,
        size: attachment.size,
        mimeType: "application/octet-stream",
        data: attachment.data,
    };
}

ToolRegistry.register({
    name: "read_attachment",
    description:
        "Read and extract structured content from a file attachment. " +
        "Returns text content for documents, metadata for images, and structured data for PDFs/Word/Excel. " +
        "This tool is available in Ask, Plan, Build, Debug, Review, and chat-only modes. " +
        "Call it whenever the user references an uploaded file or attachment. " +
        "Use this when you need to analyze or process files the user has attached to the conversation. " +
        "If content extraction fails, check rawBase64 for the original file data.",
    category: ToolCategory.FILE,
    cost: 0,
    requiresWorkspace: false,
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

        if (isBlockedSecretBasename(attachment.filename)) {
            return { success: false, error: ENV_SECRET_BLOCK_MESSAGE };
        }

        try {
            let structuredData = extractStructuredData(attachment);

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

ToolRegistry.register({
    name: "list_attachments",
    description:
        "List all available file attachments in the current conversation. " +
        "This tool is available in Ask, Plan, Build, Debug, Review, and chat-only modes. " +
        "Call it whenever the user references an uploaded file or attachment. " +
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
