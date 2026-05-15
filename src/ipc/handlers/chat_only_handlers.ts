/**
 * Chat-Only Stream Handlers (Ephemeral/Incognito Mode)
 * =====================================================
 * Simplified handler for chat-only sessions (no workspace/app)
 * 
 * This provides:
 * - Core tools: web_search, read_url, request_tools
 * - No codebase context
 * - No file operations
 * - Simple, fast responses
 * - NO DATABASE STORAGE (incognito mode - chat disappears on close)
 */

import { app, IpcMainInvokeEvent } from "electron";
import {
    streamText,
    ToolSet,
    jsonSchema as aiJsonSchema,
    type ModelMessage,
} from "ai";
import {
    buildContinuationPrompt,
    shouldContinue,
} from "../../lib/streaming/continuation-handler";
import { readSettings } from "../../main/settings";
import {
  getModelClient,
  getEffectiveModel,
  type GetModelClientOptions,
} from "../utils/get_model_client";
import { safeSend } from "../utils/safe_sender";
import { stripThinkBlocks } from "../utils/thinking_tags";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import { ChatStreamParams, ChatResponseEnd, Message } from "../ipc_types";
import {
    AI_STREAM_EMPTY_RESPONSE_FALLBACK,
    AI_STREAMING_ERROR_MESSAGE_PREFIX,
    SAFETY_FILTER_BLOCKED_MESSAGE,
} from "@/shared/texts";
import { STREAM_TOOL_LOOP_DURATION_CAP_MS } from "@/constants/settings_constants";
import {
    prepareUserChatTurnInput,
    ChatPromptSafetyError,
} from "../../lib/security/chat-prompt-gate";
import { sanitizeAssistantOutput } from "../../lib/security/profanity-filter";
import {
    attachEmptyOutputSafeRejectHandlers,
    isNoUsableModelOutputError,
    MODEL_EMPTY_RESPONSE_USER_MESSAGE,
} from "../utils/no_usable_model_output";
import {
  getCompassUsageFromSupabase,
  recordCompassUsageTokens,
  totalTokensFromAiUsage,
} from "../../lib/auth/compass_usage";
import { estimateTokens } from "../utils/token_utils";
import { runMidLoopCompaction, pruneToolOutputsInModelMessages } from "@/lib/context/mid_loop_compaction";
import { guardToolCall } from "@/lib/tools/guard";
import {
    compassExhaustedUserMessage,
    COMPASS_REACHABILITY_ERROR,
} from "../shared/compass_constants";
import { ToolRegistry } from "../../lib/tools";
import { renderModeSystemBlock } from "../../prompts/system_prompt";
import { getSessionMemory } from "../../lib/session-memory";
import { getToolActivityLabel } from "../../lib/tool-activity-labels";
import type { LargeLanguageModel } from "../../lib/schemas";
import { getExtraProviderOptions } from "../utils/thinking_utils";
import {
    buildReasoningProviderOptions,
    detectReasoningCapability,
    resolveReasoningCatalogModelId,
    hasNativeDeepThinkingSupport,
} from "@/lib/routing/reasoning-detector";
import { resolveContextBudgetTier } from "@/lib/routing/context_budget_routing";
import { resolveModelContextLimit } from "@/lib/context/resolve-model-context-limit";
import type { ModelTier } from "@/lib/routing/capability-registry";
import { escapeAtlarixTags } from "../utils/escape_atlarix_tags";
import { parseQuestions } from "../utils/cleanFullResponse";
import { captureSafe } from "../../main/lib/analytics";
import { summarizeOversizedToolResultsInContent } from "@/lib/context/post_turn_tool_result_summary";
import * as path from "path";
import { readFile } from "fs/promises";
import { AttachmentStore } from "../../lib/attachment-store";
import type { TextPart, ImagePart, FilePart } from "ai";

const TEXT_FILE_EXTENSIONS = [
  ".md", ".txt", ".json", ".csv", ".js", ".ts", ".html", ".css", ".py", ".yaml", ".yml", ".xml", ".sh", ".bash", ".zsh", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".sql", ".graphql", ".env", ".gitignore", ".eslintrc", ".prettierrc",
];

async function isTextFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.includes(ext);
}

/**
 * Process attachments and return formatted attachment info string.
 * Also stores attachments in AttachmentStore for read_attachment tool.
 */
async function processAttachments(attachments: ChatStreamParams["attachments"]): Promise<{ attachmentInfo: string; attachmentIds: string[]; attachmentInfos: { id: string; filename: string; mimeType: string; size: number }[] }> {
  const attachmentIds: string[] = [];
  const attachmentInfos: { id: string; filename: string; mimeType: string; size: number }[] = [];
  let attachmentInfo = "";

  if (!attachments || attachments.length === 0) {
    return { attachmentInfo, attachmentIds, attachmentInfos };
  }

  const { default: crypto } = await import("crypto");
  const TEMP_DIR = path.join(require("os").tmpdir(), "atlarix-attachments");
  const { writeFile, mkdir } = await import("fs/promises");
  const { existsSync } = await import("fs");

  if (!existsSync(TEMP_DIR)) {
    await mkdir(TEMP_DIR, { recursive: true });
  }

  const mimeTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };

  logger.log(`Processing ${attachments.length} attachments for chat-only mode`);

  for (const attachment of attachments) {
    const hash =
      attachment.id ||
      crypto
        .createHash("md5")
        .update(attachment.name + Date.now())
        .digest("hex");
    const fileExtension = path.extname(attachment.name);
    const filename = `${hash}${fileExtension}`;
    const filePath = path.join(TEMP_DIR, filename);

    const base64Data = attachment.data.split(";base64,").pop() || "";
    const fileSize = Buffer.from(base64Data, "base64").length;
    await writeFile(filePath, Buffer.from(base64Data, "base64"));

    const mimeType = mimeTypes[fileExtension] || "application/octet-stream";

    AttachmentStore.add({
      id: hash,
      filename: attachment.name,
      mimeType,
      data: base64Data,
      size: fileSize,
      addedAt: Date.now(),
    });

    attachmentIds.push(hash);
    attachmentInfos.push({
      id: hash,
      filename: attachment.name,
      mimeType,
      size: fileSize,
    });
    logger.log(`Saved attachment: ${filePath} (id: ${hash}, original: ${attachment.name})`);
  }

  // Build attachment info for LLM (directive, to reduce "please attach" responses)
  attachmentInfo =
    "\n\nFILES ATTACHED (already uploaded; do NOT ask the user to attach again):\n";
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const attachmentId = attachmentIds[i];
    const fileExtension = path.extname(attachment.name);
    const isText = TEXT_FILE_EXTENSIONS.includes(fileExtension);
    const mimeType = attachment.type || "application/octet-stream";
    const size = attachmentInfos[i]?.size ?? 0;

    attachmentInfo += `- name: "${attachment.name}" | attachmentId: ${attachmentId} | mime: ${mimeType} | kind: ${isText ? "text" : "binary"} | size: ${size}\n`;
    if (isText) {
      const filePath = path.join(TEMP_DIR, `${attachmentIds[i]}${fileExtension}`);
      try {
        const fullContent = await readFile(filePath, "utf-8");
        attachmentInfo += `  preview:\n  ---\n  ${fullContent
          .slice(0, 1500)
          .replace(/\n/g, "\n  ")}\n  ---\n`;
      } catch (err) {
        logger.warn(`Error reading text file content: ${err}`);
      }
    }
  }
  attachmentInfo +=
    '\nMANDATORY TOOL USE:\n- If the user asks to read/summarize any attached file, you MUST call the tool `read_attachment` with the exact `attachmentId` shown above.\n- Example: read_attachment({ "attachmentId": "<id>" })\n';

  return { attachmentInfo, attachmentIds, attachmentInfos };
}

async function replaceTextAttachmentWithContent(
  text: string,
  filePath: string,
  fileName: string,
): Promise<string> {
  try {
    if (await isTextFile(filePath)) {
      const fullContent = await readFile(filePath, "utf-8");
      const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tagPattern = new RegExp(
        `<atlarix-text-attachment filename="[^"]*" type="[^"]*" path="${escapedPath}">\\s*<\\/atlarix-text-attachment>`,
        "g",
      );
      const replacedText = text.replace(
        tagPattern,
        `Full content of ${fileName}:\n\`\`\`\n${fullContent}\n\`\`\``,
      );
      logger.log(
        `Replaced text attachment content for: ${fileName} - length before: ${text.length} - length after: ${replacedText.length}`,
      );
      return replacedText;
    }
    return text;
  } catch (error) {
    logger.error(`Error processing text file: ${error}`);
    return text;
  }
}

const logger = log.scope("chat_only_handlers");

/** Latest streaming assistant tail for pure chat-only (synthetic id -1); used when flushing ask_user submit chunks. */
export const chatOnlyStreamingAssistantDraftByChatId = new Map<number, string>();

export function syncChatOnlyStreamingDraft(chatId: number, tail: string): void {
    chatOnlyStreamingAssistantDraftByChatId.set(chatId, tail);
}

export function clearChatOnlyStreamingDraft(chatId: number): void {
    chatOnlyStreamingAssistantDraftByChatId.delete(chatId);
}

/** Compose prompt when continuing after `<questions>` or clarifying user rows (last two user messages). */
export function buildContinueAfterQuestionsPrompt(
    msgs: { role: string; content?: string | null }[],
): string {
    const userMsgs = msgs.filter((m) => m.role === "user");
    if (userMsgs.length === 0) return "";
    if (userMsgs.length === 1) return String(userMsgs[0].content ?? "").trim();
    const a = String(userMsgs[userMsgs.length - 2]?.content ?? "").trim();
    const b = String(userMsgs[userMsgs.length - 1]?.content ?? "").trim();
    if (!a) return b;
    if (!b) return a;
    return `${a}\n\n---\n\n${b}`;
}

/**
 * Insert ask_user formatted answer as a user row after the assistant segment that hosted the question.
 */
export function insertAskUserAnswerUserMessage(chatId: number, formattedContent: string): boolean {
    const chat = ephemeralChats.get(chatId);
    if (!chat) return false;
    const msgs = chat.messages;
    const msg: Message = {
        id: Date.now(),
        chatId,
        role: "user",
        content: formattedContent,
        createdAt: new Date(),
    };
    msgs.push(msg);
    return true;
}

/**
 * Insert clarifying `<questions>` formatted answer bubble before the assistant message that hosted the widget (by id).
 */
export function insertClarifyingAnswersUserMessageEphemeral(
    chatId: number,
    assistantMessageId: number,
    formattedContent: string,
): boolean {
    const chat = ephemeralChats.get(chatId);
    if (!chat) return false;
    const msgs = chat.messages;
    const idx = msgs.findIndex((m) => m.id === assistantMessageId);
    if (idx < 0) return false;
    const msg: Message = {
        id: Date.now(),
        chatId,
        role: "user",
        content: formattedContent,
        createdAt: new Date(),
    };
    msgs.splice(idx + 1, 0, msg);
    return true;
}

/**
 * Edit a user message in an ephemeral chat and truncate messages after it.
 * Used by `chat:edit-message` when chatId is negative (incognito/home chat).
 */
export function editEphemeralUserMessage(
    chatId: number,
    userMessageId: number,
    newContent: string,
): boolean {
    const chat = ephemeralChats.get(chatId);
    if (!chat) return false;
    const idx = chat.messages.findIndex(
        (m) => m.id === userMessageId && m.role === "user",
    );
    if (idx < 0) return false;
    const prev = chat.messages[idx];
    chat.messages[idx] = { ...prev, content: newContent };
    chat.messages = chat.messages.slice(0, idx + 1);
    return true;
}

/** Keep first occurrence per normalized URL (strip hash); entries without URL pass through. */
function dedupeCollectedSourcesByUrl(sources: any[]): any[] {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const s of sources) {
        const rawUrl = (s as { url?: string; link?: string }).url ?? (s as { link?: string }).link;
        const url =
            typeof rawUrl === "string"
                ? rawUrl.trim().toLowerCase().split("#")[0]
                : "";
        if (!url) {
            out.push(s);
            continue;
        }
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(s);
    }
    return out;
}

// Active streams for cancellation
const activeStreams = new Map<number, AbortController>();

// In-memory ephemeral chat storage (incognito mode - no DB persistence)
const ephemeralChats = new Map<number, {
    id: number;
    title: string;
    messages: Message[];
    createdAt: Date;
    appId?: number; // Optional: workspace association for ephemeral workspace chats
}>();

// Counter for ephemeral chat IDs (negative to distinguish from DB IDs)
let ephemeralChatCounter = -1;

/**
 * Create a new ephemeral chat (not saved to database)
 */
export function createEphemeralChat(): number {
    const id = ephemeralChatCounter--;
    ephemeralChats.set(id, {
        id,
        title: "New chat",
        messages: [],
        createdAt: new Date(),
    });
    logger.log(`Created ephemeral chat: ${id}`);
    return id;
}

/**
 * Create a new ephemeral workspace chat (not saved to database, but associated with workspace)
 * This allows workspace context while keeping chats ephemeral (incognito)
 */
export function createEphemeralWorkspaceChat(appId: number): number {
    const id = ephemeralChatCounter--;
    ephemeralChats.set(id, {
        id,
        title: "New chat",
        messages: [],
        createdAt: new Date(),
        appId, // Associate with workspace for context
    });
    logger.log(`Created ephemeral workspace chat: ${id} for app: ${appId}`);
    return id;
}

/**
 * Get the appId for an ephemeral chat (if it's a workspace chat)
 */
export function getEphemeralChatAppId(chatId: number): number | undefined {
    return ephemeralChats.get(chatId)?.appId;
}

/**
 * Get ephemeral chat by ID
 */
export function getEphemeralChat(chatId: number) {
    return ephemeralChats.get(chatId);
}

/**
 * Check if a chat ID is ephemeral
 */
export function isEphemeralChatId(chatId: number): boolean {
    return chatId < 0;
}

/**
 * Clear all ephemeral chats (e.g., on app close)
 */
export function clearEphemeralChats(): void {
    ephemeralChats.clear();
    ephemeralChatCounter = -1;
    logger.log("Cleared all ephemeral chats");
}

/**
 * Add a message to an ephemeral chat
 */
export function addEphemeralMessage(
    chatId: number,
    message: {
        role: string;
        content: string;
        autoRoutedTier?: "fast" | "balanced" | "thinking";
    },
): void {
    const chat = ephemeralChats.get(chatId);
    if (chat) {
        chat.messages.push({
            ...message,
            id: Date.now(),
            chatId,
            createdAt: new Date(),
        } as any);
        logger.log(`Added message to ephemeral chat ${chatId}: "${message.content.substring(0, 50)}..."`);
    }
}

/**
 * System prompt for chat-only mode (no workspace) — includes runtime app version and NorahLabs identity.
 * PASS8 A2 + A3 + A5: Returns a stable header (cacheable) + dynamic tail (per-turn).
 * Chat-only has no workspace, so the active mode is always Ask.
 */
function getChatOnlySystemPromptParts(appVersion: string): { stableHeader: string; dynamicTail: string } {
    const stableHeader = `You are the in-app assistant for **Atlarix**, the desktop AI coding copilot built by **NorahLabs** (norahlabs.com). Product site: atlarix.dev.

<tool_contract>
Every-mode tools: read_attachment, list_attachments, compress_context, web_search, deep_research, ask_user.
Workspace-only tools (file read/write, search, diagram, etc.) are NOT available in chat-only mode.
If a tool is in your tool list, call it; do not claim it is missing.
</tool_contract>

${renderModeSystemBlock("ask")}

## App version (answer exactly when asked)
The user is running Atlarix app version **${appVersion}**. If they ask what version you are, what version the app is, or similar, give that version string. Do not say you have no version number.

## What you are
- **Atlarix** is the product; you are its assistant inside this Electron app — not a separate generic chat service.
- **Compass** (Fast / Balanced / Thinking in Settings) is Atlarix's optional managed model tier when that provider is selected; mention it only if the user asks about model tiers.

## Your capabilities (this mode: no workspace open yet)
You can help with:
- Answering questions on many topics
- Web research: you have **web_search** and **deep_research** — use **exactly one per research topic per turn** (never both for the same or overlapping topic). **web_search** = quick single-query facts; **deep_research** = multi-source synthesis (it searches internally—do not add **web_search** for the same subject afterward). **read_url** = user gave a specific URL.
- Planning before building

## When the user wants to build something
1. Understand requirements; ask clarifying questions if needed
2. Call create_workspace() to set up a project when appropriate

After a workspace exists in the full flow, file and codebase tools unlock; in this chat-only path you still guide them toward create_workspace first.

## What you cannot do until a workspace exists
You cannot read, write, or run commands on the user's project files from this mode alone — point them to creating/opening a workspace in Atlarix when they want hands-on code changes.
This does NOT apply to attachments. read_attachment and list_attachments work in
chat-only mode and must be used when the user provides a file attachment.

## File Attachments
When the user attaches files (PDF, images, documents, etc.), the file information will appear in your message context with:
- The original filename
- A unique attachment ID
- MIME type
- Content preview (for text files)

**To access attachment content**, you MUST call the read_attachment tool with the attachment ID shown in the message. Example: read_attachment({ "attachmentId": "abc123def456" })

Do NOT try to guess or make up attachment IDs. Use the exact ID provided in the message context.

## Formatting rules
- Thinking: wrap in <redacted_thinking>...</redacted_thinking> when needed (collapsible in UI)
- Do not announce "let me search" — answer directly; tools run without narration
- Keep responses focused

## Important
- Be helpful and conversational. **RULE:** For one user question, pick **either** **web_search** **or** **deep_research**, never both in the same turn for overlapping topics. After **deep_research**, answer from its output only.`;

    const currentDateTime = new Date().toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
    });
    const dynamicTail = `# Current date and time
Today is ${currentDateTime}. Use this date when answering questions about "today", "current", or "latest", and when using web_search for time-sensitive queries.`;
    return { stableHeader, dynamicTail };
}

/** Backwards-compatible single-string joiner. */
function getChatOnlySystemPrompt(appVersion: string): string {
    const { stableHeader, dynamicTail } = getChatOnlySystemPromptParts(appVersion);
    return `${stableHeader}\n\n${dynamicTail}\n`;
}

/**
 * Handle chat-only stream request (ephemeral/incognito - no database)
 */
/** Optional: global MCP toolset (when appId is null). Passed from stream handler to avoid circular deps. */
export type McpToolSet = Record<string, { description?: string; parameters?: object; execute: (args: any, ctx?: any) => Promise<unknown> }>;

export async function handleChatOnlyStream(
    event: IpcMainInvokeEvent,
    req: ChatStreamParams,
    abortController: AbortController,
    mcpTools?: McpToolSet
): Promise<string> {
    logger.log("Starting ephemeral chat-only stream for chat:", req.chatId);

    let usedCompassThisStream = false;
    let compassTierForEnd: string | undefined;
    let compassTokensForEnd: number | undefined;
    try {
        const settings = await readSettings();

        // Get or create ephemeral chat (continue-after-questions requires an existing session)
        let chat = ephemeralChats.get(req.chatId);
        if (!chat) {
            if (req.continueAfterQuestions) {
                safeSend(event.sender, "chat:response:error", {
                    chatId: req.chatId,
                    error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}No chat session to continue.`,
                });
                safeSend(event.sender, "chat:response:end", {
                    chatId: req.chatId,
                    updatedFiles: false,
                    hadToolCallsOrPermissions: false,
                } satisfies ChatResponseEnd);
                activeStreams.delete(req.chatId);
                return "";
            }
            chat = {
                id: req.chatId,
                title: "New chat",
                messages: [],
                createdAt: new Date(),
            };
            ephemeralChats.set(req.chatId, chat);
        }

        let gatedPrompt: string;
        try {
            if (req.continueAfterQuestions) {
                const composed = buildContinueAfterQuestionsPrompt(chat.messages);
                if (!composed.trim()) {
                    throw new Error("Continue after questions: no user message content found");
                }
                gatedPrompt = prepareUserChatTurnInput(composed);
            } else {
                gatedPrompt = prepareUserChatTurnInput(req.prompt);
            }
        } catch (gateErr) {
            if (gateErr instanceof ChatPromptSafetyError) {
                safeSend(event.sender, "chat:response:error", {
                    chatId: req.chatId,
                    error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${SAFETY_FILTER_BLOCKED_MESSAGE}`,
                });
                safeSend(event.sender, "chat:response:end", {
                    chatId: req.chatId,
                    updatedFiles: false,
                    hadToolCallsOrPermissions: false,
                } satisfies ChatResponseEnd);
                activeStreams.delete(req.chatId);
                return "";
            }
            if (
                gateErr instanceof Error &&
                /maximum length|Invalid prompt/i.test(gateErr.message)
            ) {
                safeSend(event.sender, "chat:response:error", {
                    chatId: req.chatId,
                    error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${gateErr.message}`,
                });
                safeSend(event.sender, "chat:response:end", {
                    chatId: req.chatId,
                    updatedFiles: false,
                    hadToolCallsOrPermissions: false,
                } satisfies ChatResponseEnd);
                activeStreams.delete(req.chatId);
                return "";
            }
            const msg =
                gateErr instanceof Error ? gateErr.message : String(gateErr);
            safeSend(event.sender, "chat:response:error", {
                chatId: req.chatId,
                error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${msg}`,
            });
            safeSend(event.sender, "chat:response:end", {
                chatId: req.chatId,
                updatedFiles: false,
                hadToolCallsOrPermissions: false,
            } satisfies ChatResponseEnd);
            activeStreams.delete(req.chatId);
            return "";
        }

        // Process attachments BEFORE creating user message so attachment info appears in UI
        let attachmentInfosForMessage: { id: string; filename: string; mimeType: string; size: number }[] = [];
        if (!req.continueAfterQuestions && req.attachments && req.attachments.length > 0) {
            try {
                const { attachmentInfo, attachmentInfos } = await processAttachments(req.attachments);
                gatedPrompt += attachmentInfo;
                attachmentInfosForMessage = attachmentInfos;
                logger.log(`Appended attachment info to prompt. Total length: ${gatedPrompt.length}`);
            } catch (err) {
                logger.warn(`Error processing attachments: ${err}`);
            }
        }

        if (!req.continueAfterQuestions) {
            const userMessage: Message = {
                id: Date.now(),
                chatId: req.chatId,
                role: "user",
                content: req.prompt ?? "",
                createdAt: new Date(),
                attachments: attachmentInfosForMessage.length > 0 ? attachmentInfosForMessage : null,
            };
            chat.messages.push(userMessage);

            if (chat.messages.length === 1) {
                const words = gatedPrompt.split(" ").slice(0, 5).join(" ");
                chat.title =
                    words.length > 30 ? words.substring(0, 30) + "..." : words;
                logger.info(`Set ephemeral chat ${req.chatId} title: "${chat.title}"`);
            }

            safeSend(event.sender, "chat:response:chunk", {
                chatId: req.chatId,
                messages: [...chat.messages],
            });
        }

        // Log which model is being used (helps verify Auto vs single model)
        const mainOptions: GetModelClientOptions = {
            agentMode: settings.agentMode ?? "guided",
            delegationRole: "main",
        };
        let effectiveModel = getEffectiveModel(settings);
        if (req.modelOverride) {
            effectiveModel = req.modelOverride;
        }

        const sel = effectiveModel as { provider?: string; name?: string };
        if (sel?.provider === "auto") {
            const ids = settings.autoModelIds;
            logger.log(`Chat-only model: Auto (provider=${settings.autoProviderId ?? "default"}, models=${Array.isArray(ids) ? ids.join(", ") : "default chain"})`);
        } else {
            logger.log(`Chat-only model: ${sel?.provider ?? "?"}/${sel?.name ?? "?"}`);
        }

        let autoRoutedTierForTurn: import("@/lib/routing/capability-registry").ModelTier | null =
            null;

        if (
            !req.modelOverride &&
            settings.autoModelRouting &&
            effectiveModel.provider === "auto"
        ) {
            const { runAutoRouterAsync, recommendModeRoute } = await import(
                "../../lib/routing/auto-router"
            );
            const { getRecentAssistantRoutingTiers } = await import(
                "../../lib/routing/auto-router-context"
            );
            const routingMsgs = chat.messages.map((m) => ({
                role: m.role,
                content: m.content ?? "",
                autoRoutedTier: m.autoRoutedTier,
            }));
            const recentAssistantTiers = getRecentAssistantRoutingTiers(routingMsgs, 3);
            const lastTier = recentAssistantTiers[0] ?? null;
            const messageIndex = chat.messages.filter((m) => m.role === "user").length;
            const { decision, model, classifierMeta } = await runAutoRouterAsync(
                gatedPrompt,
                settings,
                mainOptions,
                {
                    messages: routingMsgs,
                    taskState: {
                        currentMode: settings.selectedChatMode ?? "ask",
                        workModePreference: settings.workModePreference ?? "ask",
                        agentMode: settings.agentMode ?? "guided",
                        hasActivePlan: false,
                        lastTier,
                        messageIndex,
                        recentAssistantTiers,
                    },
                },
            );
            effectiveModel = model;
            autoRoutedTierForTurn = decision.tier;
            const modeRoute = recommendModeRoute({
                prompt: gatedPrompt,
                hasPlan: false,
                activeBuild: settings.selectedChatMode === "build",
                lastMode: settings.workModePreference,
            });
            if (settings.autoRoutingShowReasoning !== false) {
                const srcLabel =
                    classifierMeta.source === "groq"
                        ? "groq"
                        : classifierMeta.source === "fast-model"
                          ? "fast-model"
                          : "fallback";
                const pctPart =
                    classifierMeta.confidence != null
                        ? ` (${Math.round(classifierMeta.confidence * 100)}%)`
                        : "";
                safeSend(event.sender, "chat:activity", {
                    id: `classifier-${req.chatId}-${Date.now()}`,
                    type: "classifier_routing",
                    label: `Classifier → ${classifierMeta.tier}${pctPart} via ${srcLabel}`,
                    status: "done",
                    timestamp: Date.now(),
                    chatId: req.chatId,
                });
                const agentHint = decision.recommendedAgent
                    ? ` · delegate: ${String(decision.recommendedAgent).replace(/^./, (c) => c.toUpperCase())}`
                    : "";
                safeSend(event.sender, "chat:activity", {
                    id: `routing-${req.chatId}-${Date.now()}`,
                    type: "routing_decision",
                    label: `Auto → ${decision.targetModel} (${decision.category})${agentHint}`,
                    status: "done",
                    timestamp: Date.now(),
                    chatId: req.chatId,
                    detail: `${modeRoute.recommended_mode}: ${modeRoute.reason}`,
                });
            }
        }

        // Get model client (resolved tier when auto routing ran above)
        const { modelClient } = await getModelClient(
            effectiveModel,
            settings,
            mainOptions,
        );
        usedCompassThisStream = modelClient.builtinProviderId === "compass";

        if (modelClient.builtinProviderId === "compass") {
            const usagePre = await getCompassUsageFromSupabase();
            if (usagePre.ok && usagePre.tier) {
                compassTierForEnd = usagePre.tier;
            }
            if (
                usagePre.ok &&
                usagePre.monthlyLimit > 0 &&
                usagePre.tokensUsedThisMonth >= usagePre.monthlyLimit
            ) {
                safeSend(event.sender, "chat:response:error", {
                    chatId: req.chatId,
                    error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${compassExhaustedUserMessage(usagePre.tier)}`,
                });
                safeSend(event.sender, "chat:response:end", {
                    chatId: req.chatId,
                    updatedFiles: false,
                    hadToolCallsOrPermissions: false,
                    usedCompass: true,
                    compassTier: compassTierForEnd,
                } satisfies ChatResponseEnd);
                activeStreams.delete(req.chatId);
                return "";
            }
        }

        const forceThinkingNativeSupported =
            req.forceThinkingTier === true
                ? hasNativeDeepThinkingSupport(
                      effectiveModel as LargeLanguageModel,
                      modelClient.builtinProviderId,
                      settings,
                  )
                : false;

        let contextBudgetTier = resolveContextBudgetTier(
            effectiveModel as LargeLanguageModel,
            settings,
        );
        if (autoRoutedTierForTurn === "thinking") {
            contextBudgetTier = "thinking";
        }
        if (req.forceThinkingTier === true && forceThinkingNativeSupported) {
            contextBudgetTier = "thinking";
        }
        const thinkingTier = contextBudgetTier === "thinking";
        const thinkingTierEffective =
            thinkingTier &&
            !(req.forceThinkingTier === true && !forceThinkingNativeSupported);

        let deepThinkCounselPromptBlock: string | null = null;
        if (
            req.forceThinkingTier === true &&
            !forceThinkingNativeSupported &&
            settings.counsel?.enabled !== false
        ) {
            try {
                const { runCounselPipeline } = await import("@/lib/counsel/counsel-runner");
                const cleanQ = gatedPrompt.slice(0, 12000);
                deepThinkCounselPromptBlock = await runCounselPipeline({
                    chatId: req.chatId,
                    turnId: `chat-only-${req.chatId}-${Date.now()}`,
                    trigger: "deep_think_fallback",
                    mode: "general",
                    question: cleanQ,
                    settings,
                    sendActivity: (payload) => {
                        safeSend(event.sender, "chat:activity", payload);
                    },
                    toolActivity: { webContents: event.sender, chatId: req.chatId },
                    onCounselStreamLifecycle: (phase) => {
                        safeSend(event.sender, "chat:stream:phase", {
                            chatId: req.chatId,
                            phase,
                            label: phase === "counsel_start" ? "Consulting the counsel..." : "",
                        });
                    },
                });
            } catch (deepCounselErr) {
                logger.warn("[chat-only][counsel] Deep-think substitute failed:", deepCounselErr);
                deepThinkCounselPromptBlock = null;
            }
        }

        // No workspace = read-only only (no write/run/delegation) + global MCP tools when provided
        const availableTools = ToolRegistry.getToolsForNoWorkspace();
        logger.log(`Chat-only mode (read-only): ${availableTools.length} built-in tools available`);

        // Track sources from tool calls
        const collectedSources: any[] = [];

        const PERMISSIVE_SCHEMA = aiJsonSchema({ type: "object" as const, properties: {}, additionalProperties: true });

        // Convert tools to AI SDK format with properly wrapped schemas
        const tools: ToolSet = {};
        for (const tool of availableTools) {
            tools[tool.name] = {
                description: tool.description,
                inputSchema: PERMISSIVE_SCHEMA,
                execute: async (params: any) => {
                    // Fix: Finding 4
                    safeSend(event.sender, "chat:tool:start", {
                        chatId: req.chatId,
                        toolId: tool.name,
                        toolName: getToolActivityLabel(tool.name),
                    });
                    try {
                    // FIX 3: wrap the entire built-in dispatch in guardToolCall
                    // so missing params return INVALID_PARAMS and any thrown
                    // handler error is caught as TOOL_ERROR. Permission-required
                    // markers (none today on the chat-only path, but kept for
                    // parity) are passed through.
                    return await guardToolCall({
                        toolName: tool.name,
                        args: params,
                        parametersSchema: (tool as { parameters?: unknown }).parameters,
                        runner: async () => {
                    const paramsObj = params as Record<string, unknown>;

                    logger.log(`Executing tool: ${tool.name}`);
                    const result = await tool.handler({ ...params, chatId: req.chatId });

                    if (
                        tool.name === "compress_context" &&
                        result &&
                        typeof result === "object" &&
                        (result as any).__compress_context_requested === true
                    ) {
                        // PASS2: Compaction is model-triggered via compress_context.
                        // Emit activity + run compaction here (tool handler has no stream scope).
                        const reason = (result as any).reason ?? "model-initiated";
                        safeSend(event.sender, "chat:activity", {
                            id: `compress-context-${req.chatId}-${Date.now()}`,
                            type: "compaction",
                            label: "Context compressed",
                            status: "running",
                            timestamp: Date.now(),
                            detail: String(reason),
                            chatId: req.chatId,
                        });

                        try {
                            const settingsNow = await readSettings();
                            const providerId = settingsNow.selectedModel?.provider;
                            const { executeCompressContext } = await import("@/lib/tools/workspace");
                            const msgList = chat.messages.map((m: any) => ({
                                id: m.id,
                                role: m.role,
                                content: m.content || "",
                            }));
                            const outcome = await executeCompressContext(
                                { reason },
                                {
                                    chatId: req.chatId,
                                    messages: msgList,
                                    systemPromptTokens: 0,
                                    inputTokens: 0,
                                    providerId,
                                    ephemeral: true,
                                    setMessages: (next) => {
                                        chat.messages = next.map((m: any) => ({
                                            ...m,
                                            chatId: req.chatId,
                                            createdAt: new Date(),
                                        })) as any;
                                    },
                                }
                            );

                            safeSend(event.sender, "chat:activity", {
                                id: `compress-context-${req.chatId}-${Date.now()}`,
                                type: "compaction",
                                label: "Context compressed",
                                status: "done",
                                timestamp: Date.now(),
                                detail: `${outcome.tokensBefore} → ${outcome.tokensAfter} tokens. ${outcome.status}`,
                                chatId: req.chatId,
                                modelInitiated: true,
                            });
                            return JSON.stringify({
                                success: outcome.success,
                                reason: outcome.reason,
                                tokensBefore: outcome.tokensBefore,
                                tokensAfter: outcome.tokensAfter,
                                summary: outcome.summary,
                                status: outcome.status,
                            });
                        } catch (e) {
                            safeSend(event.sender, "chat:activity", {
                                id: `compress-context-${req.chatId}-${Date.now()}`,
                                type: "compaction",
                                label: "Context compressed",
                                status: "error",
                                timestamp: Date.now(),
                                detail: String(e),
                                chatId: req.chatId,
                                modelInitiated: true,
                            });
                            return JSON.stringify({ success: false, error: String(e) });
                        }
                    }

                    if (
                        tool.name === "ask_user" &&
                        result &&
                        typeof result === "object" &&
                        (result as { __ask_user?: boolean }).__ask_user === true
                    ) {
                        const q = result as { question: string; options?: string[] };
                        const { waitForUserQuestionAnswer } = await import("./user_question_wait");
                        const segmentA = fullResponse;
                        if (segmentA.trim().length > 0) {
                            chat.messages.push({
                                id: Date.now(),
                                chatId: req.chatId,
                                role: "assistant",
                                content: segmentA,
                                createdAt: new Date(),
                            });
                        }
                        fullResponse = "";
                        syncChatOnlyStreamingDraft(req.chatId, "");
                        safeSend(event.sender, "chat:response:chunk", {
                            chatId: req.chatId,
                            messages: [
                                ...chat.messages,
                                {
                                    id: -1,
                                    chatId: req.chatId,
                                    role: "assistant",
                                    content: "",
                                    createdAt: new Date(),
                                },
                            ],
                        });
                        const questionId = `uq_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
                        safeSend(event.sender, "user-question-request", {
                            chatId: req.chatId,
                            questionId,
                            question: q.question ?? "",
                            options: Array.isArray(q.options) && q.options.length > 0 ? q.options : undefined,
                        });
                        const answer = await waitForUserQuestionAnswer(req.chatId, questionId, 30 * 60 * 1000);
                        return JSON.stringify({ success: true, answer });
                    }

                    if (result && typeof result === 'object' && result.sources) {
                        collectedSources.push(...result.sources);
                        return result.text || result;
                    }

                    return result;
                        },
                    });
                    } finally {
                        safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                    }
                },
            };
        }

        // Merge global MCP tools (GitHub, etc.) with safe schema wrapping — never overwrite built-ins
        if (mcpTools && Object.keys(mcpTools).length > 0) {
            let skippedBuiltinCollision = 0;
            let mergedMcpCount = 0;
            for (const [name, tool] of Object.entries(mcpTools)) {
                if (Object.prototype.hasOwnProperty.call(tools, name)) {
                    skippedBuiltinCollision += 1;
                    logger.log(
                        `Chat-only mode: skipping MCP tool "${name}" (built-in already registered)`,
                    );
                    continue;
                }
                const t = tool as { description?: string; execute?: (...args: any[]) => any; inputSchema?: unknown };
                tools[name] = {
                    description: t.description,
                    inputSchema: PERMISSIVE_SCHEMA,
                    // FIX 3: wrap external MCP execute in guardToolCall.
                    // MCP schemas are not exposed to the registry, so the
                    // INVALID_PARAMS check is a no-op (parametersSchema is
                    // undefined); TOOL_ERROR trap still applies.
                    execute: t.execute
                        ? async (args: any) =>
                              guardToolCall({
                                  toolName: name,
                                  args,
                                  parametersSchema: undefined,
                                  runner: () => t.execute!(args),
                              })
                        : undefined,
                } as any;
                mergedMcpCount += 1;
            }
            logger.log(
                `Chat-only mode: +${mergedMcpCount} MCP tools (total ${Object.keys(tools).length}${skippedBuiltinCollision ? `, ${skippedBuiltinCollision} MCP name(s) skipped (built-in)` : ""})`,
            );
        }

        const toolKeys = Object.keys(tools);
        logger.log(
            `[chat-only] ToolSet keys: ${toolKeys.length}, unique names: ${new Set(toolKeys).size} (Record keys cannot duplicate)`,
        );

        const resolvedTierForCounsel = autoRoutedTierForTurn ?? contextBudgetTier;
        if (
            settings.counsel?.enabled !== false &&
            req.forceThinkingTier !== true &&
            !gatedPrompt.startsWith("Summarize from chat-id=") &&
            !gatedPrompt.startsWith("/security-review")
        ) {
            try {
                const { detectCounselTrigger, stripCounselCommand } = await import(
                    "@/lib/counsel/counsel-trigger",
                );
                const trigger = detectCounselTrigger(gatedPrompt, resolvedTierForCounsel, {
                    autoTriggerOnThinking: settings.counsel?.autoTriggerOnThinking !== false,
                    selectedChatMode: settings.selectedChatMode ?? "ask",
                });
                if (trigger) {
                    const cleanQ = stripCounselCommand(gatedPrompt).slice(0, 12000);
                    captureSafe("counsel_triggered", {
                        trigger_type: trigger,
                        chat_mode: settings.selectedChatMode ?? "unknown",
                        has_workspace: false,
                    });
                    const { runCounselPipeline } = await import("@/lib/counsel/counsel-runner");
                    const { storeCounselSynthesisForNextTurn } = await import(
                        "@/lib/counsel/counsel-next-turn-cache",
                    );
                    void runCounselPipeline({
                        chatId: req.chatId,
                        turnId: `chat-only-counsel-${req.chatId}-${Date.now()}`,
                        trigger,
                        mode: "general",
                        question: cleanQ,
                        settings,
                        sendActivity: (payload) => {
                            safeSend(event.sender, "chat:activity", payload);
                        },
                        toolActivity: { webContents: event.sender, chatId: req.chatId },
                        onCounselStreamLifecycle: (phase) => {
                            safeSend(event.sender, "chat:stream:phase", {
                                chatId: req.chatId,
                                phase,
                                label: phase === "counsel_start" ? "Consulting the counsel..." : "",
                            });
                        },
                    })
                        .then((synthesis) => {
                            if (req.chatId > 0 && synthesis.trim()) {
                                storeCounselSynthesisForNextTurn(req.chatId, synthesis);
                            }
                        })
                        .catch((counselErr) => {
                            logger.warn("[chat-only][counsel] Pipeline failed:", counselErr);
                        });
                }
            } catch (counselErr) {
                logger.warn("[chat-only][counsel] Trigger detection failed:", counselErr);
            }
        }

        // Prepare message history
        let messageHistory = chat.messages.map((msg) => ({
            role: msg.role as "user" | "assistant" | "system",
            content: msg.content,
        }));

        // Ensure model sees the gated prompt (includes attachment directive).
        // We keep the persisted/visible user bubble clean (req.prompt), but the model context must include gatedPrompt.
        if (req.continueAfterQuestions) {
            messageHistory = [
                ...messageHistory,
                { role: "user" as const, content: gatedPrompt },
            ];
        } else {
            const lastUserIdx = (() => {
                for (let i = messageHistory.length - 1; i >= 0; i--) {
                    if (messageHistory[i]?.role === "user") return i;
                }
                return -1;
            })();
            if (lastUserIdx >= 0) {
                messageHistory[lastUserIdx] = {
                    ...messageHistory[lastUserIdx],
                    content: gatedPrompt,
                };
            } else {
                messageHistory = [
                    ...messageHistory,
                    { role: "user" as const, content: gatedPrompt },
                ];
            }
        }
        // Get session memory for conversation continuity
        // For ephemeral workspace chats, use appId so memory persists across mode switches
        // For pure chat-only, use chatId
        const memoryKey = chat.appId ?? req.chatId;
        const sessionMemory = getSessionMemory(memoryKey);
        const sessionContext = sessionMemory.getContextForPrompt();
        // PASS8 A5: Two-part system payload. Static identity / mode / capability block
        // goes into `system` (cache-eligible); date/time + session memory + per-turn
        // counsel injection go into the dynamic tail prepended to messages.
        const chatOnlyParts = getChatOnlySystemPromptParts(app.getVersion());
        let chatOnlyDynamicTail = chatOnlyParts.dynamicTail;
        if (sessionContext) {
            chatOnlyDynamicTail += `\n\n${sessionContext}`;
            logger.log(`Injected session memory (${sessionMemory.getExchangeCount()} exchanges, ~${sessionMemory.estimateTokens()} tokens)`);
        }
        if (deepThinkCounselPromptBlock?.trim()) {
            chatOnlyDynamicTail += `\n\n${deepThinkCounselPromptBlock.trim()}`;
        }
        // Backwards-compat single string for any callers still reading `systemPrompt`.
        let systemPrompt = `${chatOnlyParts.stableHeader}\n\n${chatOnlyDynamicTail}\n`;
        void systemPrompt; // accessed only by token-estimate paths if present

        const mapChatOnlyTierLabel = (t: ModelTier): "fast" | "balanced" | "thinking" => {
            if (t === "thinking") return "thinking";
            if (t === "balanced") return "balanced";
            return "fast";
        };
        const chatOnlyModelCtx = await resolveModelContextLimit(
            effectiveModel as LargeLanguageModel,
            settings,
        );
        const chatOnlyTierLimit = chatOnlyModelCtx.tierLimit;
        const chatOnlyContextWindowTokens =
            chatOnlyModelCtx.rawContextLength != null && chatOnlyModelCtx.rawContextLength > 0
                ? chatOnlyModelCtx.rawContextLength
                : Math.max(1, Math.round(chatOnlyModelCtx.tierLimit / 0.8));

        const messagesForCompaction = (messageHistory as { id?: number; role: string; content?: string }[]).map((m, idx) => ({
            id: m.id ?? Date.now() + idx,
            role: m.role,
            content: m.content || "",
        }));

        const { runSteppedCompaction: chatOnlyRunCompaction } = await import("@/lib/context/compaction");
        const chatOnlyCompactionResult = await chatOnlyRunCompaction(
            messagesForCompaction,
            chatOnlyTierLimit,
            effectiveModel.provider,
        );

        if (chatOnlyCompactionResult.compactionApplied) {
            messageHistory = chatOnlyCompactionResult.modelContext.map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
            }));
            logger.info(`[compaction:chat-only] ratio=${chatOnlyCompactionResult.usageRatio.toFixed(2)} strategy=${chatOnlyCompactionResult.strategy}`);
        }

        const chatOnlyProviderOptions: Record<string, unknown> = {
            "dyad-gateway": getExtraProviderOptions(
                modelClient.builtinProviderId,
                settings,
                thinkingTierEffective,
            ),
        };
        if (
            (modelClient.builtinProviderId === "openrouter" ||
                modelClient.builtinProviderId === "compass") &&
            chatOnlyCompactionResult.compactionApplied
        ) {
            chatOnlyProviderOptions.openrouter = {
                plugins: [{ id: "context-compression" }],
            };
        }

        const modelApiId = typeof effectiveModel === 'string' ? effectiveModel : effectiveModel?.name ?? '';
        const reasoningCap = detectReasoningCapability(
            modelApiId,
            modelClient.builtinProviderId,
        );
        const reasoningPatch = buildReasoningProviderOptions(
            reasoningCap,
            thinkingTierEffective,
        );
        if (reasoningPatch.openrouter) {
            chatOnlyProviderOptions.openrouter = {
                ...(chatOnlyProviderOptions.openrouter as Record<string, unknown>),
                ...reasoningPatch.openrouter,
            };
        }
        if (reasoningPatch.google) {
            chatOnlyProviderOptions.google = reasoningPatch.google;
        }
        if (reasoningPatch.openai) {
            chatOnlyProviderOptions.openai = reasoningPatch.openai;
        }

        let fullResponse = "";
        let chatOnlyStreamMessages: ModelMessage[] = messageHistory as ModelMessage[];

        // v8.0: Attachments are now stored in AttachmentStore and accessed via read_attachment tool
        // Attachment info was appended to user message in the processing section above

        let chatOnlyContinuationAttempts = 0;
        const CHAT_ONLY_CONTINUATION_MAX = 3;

        const chatOnlyStreamLoopStartMs = Date.now();
        const nativeToolNamesThisTurn = new Set<string>();
        let lastStreamResult!: ReturnType<typeof streamText>;
        while (true) {
            if (Date.now() - chatOnlyStreamLoopStartMs > STREAM_TOOL_LOOP_DURATION_CAP_MS) {
                logger.warn("[chat-only] Hit duration limit (30 minutes)");
                safeSend(event.sender, "chat:activity", {
                    id: `duration-limit-${Date.now()}`,
                    type: "duration_limit_reached",
                    label: "Task paused after 30 minutes",
                    detail: "Send a message to continue",
                    status: "done",
                    timestamp: Date.now(),
                    chatId: req.chatId,
                });
                break;
            }
            const CHAT_ONLY_EMPTY_OUTPUT_MAX_ATTEMPTS = 2;
            const CHAT_ONLY_EMPTY_OUTPUT_RETRY_DELAY_MS = 1000;

            let fr: string | undefined;
            emptyOutputRetry: for (
                let emptyOutAttempt = 1;
                emptyOutAttempt <= CHAT_ONLY_EMPTY_OUTPUT_MAX_ATTEMPTS;
                emptyOutAttempt++
            ) {
                // PASS8 A5: Prepend dynamic tail as a system-role message.
                const chatOnlyMessages: ModelMessage[] =
                    chatOnlyDynamicTail && chatOnlyDynamicTail.trim().length > 0
                        ? [
                            { role: "system" as const, content: chatOnlyDynamicTail },
                            ...chatOnlyStreamMessages,
                        ]
                        : chatOnlyStreamMessages;
                const result = streamText({
                    model: modelClient.model,
                    system: chatOnlyParts.stableHeader,
                    messages: chatOnlyMessages,
                    tools,
                    temperature: 0.7,
                    providerOptions: chatOnlyProviderOptions as Parameters<
                        typeof streamText
                    >[0]["providerOptions"],
                    abortSignal: abortController.signal,
                    stopWhen: [() => false],
                    maxRetries: 2,
                    onFinish: (response) => {
                        const totalTokens = totalTokensFromAiUsage(response.usage);
                        if (
                            modelClient.builtinProviderId === "compass" &&
                            typeof totalTokens === "number"
                        ) {
                            compassTokensForEnd = totalTokens;
                            void recordCompassUsageTokens(totalTokens).then((r) => {
                                if (!r.ok && r.error === "limit_exceeded") {
                                    logger.warn(
                                        "[compass chat-only] Monthly limit hit while recording usage",
                                    );
                                }
                            });
                        }
                    },
                    onError: (err: unknown) => {
                        if (isNoUsableModelOutputError(err)) {
                            logger.warn(
                                "[chat-only] onError: empty/no usable model output (handled by retry/consumption)",
                                err,
                            );
                            return;
                        }
                        const errorMessage = (err as { error?: { message?: string } })?.error
                            ?.message;
                        let message = errorMessage || JSON.stringify(err);
                        if (modelClient.builtinProviderId === "compass") {
                            message = COMPASS_REACHABILITY_ERROR;
                            Sentry.captureException(
                                new Error(String(errorMessage || message).slice(0, 500)),
                                {
                                    tags: { feature: "compass", source: "chat_only_stream" },
                                    extra: { chatId: req.chatId },
                                },
                            );
                        }
                        safeSend(event.sender, "chat:response:error", {
                            chatId: req.chatId,
                            error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${message}`,
                        });
                        activeStreams.delete(req.chatId);
                    },
                });
                lastStreamResult = result;

                attachEmptyOutputSafeRejectHandlers(
                    result,
                    logger.warn.bind(logger),
                    "chat_only",
                );

                try {
                    let firstVisibleChunk = true;
                    let inThinkingBlock = false;
                    for await (const part of result.fullStream) {
                        if (abortController.signal.aborted) {
                            logger.log("Ephemeral chat-only stream aborted");
                            break;
                        }

                        let chunk = "";
                        if (
                            inThinkingBlock &&
                            !["reasoning-delta", "reasoning-start", "reasoning-end"].includes(
                                part.type,
                            )
                        ) {
                            chunk = "</think>";
                            inThinkingBlock = false;
                        }

                        if (part.type === "text-delta") {
                            let t = part.text ?? "";
                            t = t.replace(
                                /<\/?(?:function|toolcall|tool|parameter)[^>]*>/gi,
                                "",
                            );
                            chunk += t;
                        } else if (part.type === "reasoning-delta") {
                            const rtext = part.text ?? "";
                            if (rtext) {
                                if (!inThinkingBlock) {
                                    chunk = "<think>";
                                    inThinkingBlock = true;
                                }
                                chunk += escapeAtlarixTags(rtext);
                            }
                        }

                        if (!chunk) {
                            continue;
                        }

                        if (firstVisibleChunk && chunk.trim().length > 0) {
                            firstVisibleChunk = false;
                            safeSend(event.sender, "chat:stream:phase", {
                                chatId: req.chatId,
                                phase: "responding",
                                label: "",
                            });
                        }

                        fullResponse += chunk;
                        syncChatOnlyStreamingDraft(req.chatId, fullResponse);

                        safeSend(event.sender, "chat:response:chunk", {
                            chatId: req.chatId,
                            messages: [
                                ...chat.messages,
                                {
                                    id: -1,
                                    chatId: req.chatId,
                                    role: "assistant",
                                    content: fullResponse,
                                    createdAt: new Date(),
                                },
                            ],
                        });
                    }
                    if (inThinkingBlock) {
                        fullResponse += "</think>";
                        inThinkingBlock = false;
                        syncChatOnlyStreamingDraft(req.chatId, fullResponse);
                        safeSend(event.sender, "chat:response:chunk", {
                            chatId: req.chatId,
                            messages: [
                                ...chat.messages,
                                {
                                    id: -1,
                                    chatId: req.chatId,
                                    role: "assistant",
                                    content: fullResponse,
                                    createdAt: new Date(),
                                },
                            ],
                        });
                    }

                    try {
                        const tc = await result.toolCalls;
                        for (const c of tc) {
                            const name = (c as { toolName?: string }).toolName;
                            if (typeof name === "string" && name.length > 0) {
                                nativeToolNamesThisTurn.add(name);
                            }
                        }
                    } catch (tcErr) {
                        if (
                            isNoUsableModelOutputError(tcErr) &&
                            !abortController.signal.aborted &&
                            !fullResponse.trim()
                        ) {
                            // Treat as an empty-output turn so we retry / emit a user-visible error.
                            throw tcErr;
                        }
                        logger.warn(
                            "[chat-only] could not read toolCalls for native/text dedupe",
                            tcErr,
                        );
                    }
                } catch (streamErr) {
                    if (
                        isNoUsableModelOutputError(streamErr) &&
                        !abortController.signal.aborted
                    ) {
                        logger.warn("Chat-only stream: no usable text from model:", streamErr);
                        if (emptyOutAttempt < CHAT_ONLY_EMPTY_OUTPUT_MAX_ATTEMPTS) {
                            await new Promise((r) =>
                                setTimeout(r, CHAT_ONLY_EMPTY_OUTPUT_RETRY_DELAY_MS),
                            );
                            continue emptyOutputRetry;
                        }
                        if (!fullResponse.trim()) {
                            safeSend(event.sender, "chat:response:error", {
                                chatId: req.chatId,
                                error: MODEL_EMPTY_RESPONSE_USER_MESSAGE,
                            });
                            activeStreams.delete(req.chatId);
                            return "";
                        }
                    } else {
                        throw streamErr;
                    }
                }

                try {
                    fr = await result.finishReason;
                } catch (finishErr) {
                    if (
                        isNoUsableModelOutputError(finishErr) &&
                        !abortController.signal.aborted
                    ) {
                        if (emptyOutAttempt < CHAT_ONLY_EMPTY_OUTPUT_MAX_ATTEMPTS) {
                            await new Promise((r) =>
                                setTimeout(r, CHAT_ONLY_EMPTY_OUTPUT_RETRY_DELAY_MS),
                            );
                            continue emptyOutputRetry;
                        }
                        safeSend(event.sender, "chat:response:error", {
                            chatId: req.chatId,
                            error: MODEL_EMPTY_RESPONSE_USER_MESSAGE,
                        });
                        activeStreams.delete(req.chatId);
                        return "";
                    }
                    throw finishErr;
                }

                break emptyOutputRetry;
            }

            // ═══════════════════════════════════════════════════════════════
            // TEXT-BASED TOOL CALL DETECTION (for models like MiniMax)
            // Some models output tool calls as XML text instead of using
            // native function calling. Detect and execute them here.
            // ═══════════════════════════════════════════════════════════════
            const { containsTextToolCall, parseTextToolCalls } = await import("../utils/text_tool_parser");

            if (containsTextToolCall(fullResponse)) {
                logger.log("[Chat-Only] Detected text-based tool calls, parsing and executing...");
                const textToolCalls = parseTextToolCalls(fullResponse);

                for (const toolCall of textToolCalls) {
                    try {
                        if (nativeToolNamesThisTurn.has(toolCall.toolName)) {
                            logger.log(
                                `[Chat-Only] Skipping text-based tool "${toolCall.toolName}" (already executed via native tool calling)`,
                            );
                            continue;
                        }
                        const toolFn = tools[toolCall.toolName];
                        if (toolFn) {
                            logger.log(`[Chat-Only] Executing text-based tool: ${toolCall.toolName}`, toolCall.args);
                            const toolResult = await toolFn.execute?.({ ...toolCall.args, chatId: req.chatId }, {} as import("ai").ToolCallOptions);
                            const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                            fullResponse += `\n\n<atlarix-tool-result tool="${toolCall.toolName}" status="complete">\n${resultStr}\n</atlarix-tool-result>\n`;
                            logger.log(`[Chat-Only] Text-tool executed: ${toolCall.toolName} ✓`);
                            if (toolResult && typeof toolResult === 'object' && toolResult.sources) {
                                collectedSources.push(...toolResult.sources);
                            }
                        } else {
                            logger.warn(`[Chat-Only] Unknown text-tool: ${toolCall.toolName}`);
                        }
                    } catch (toolError) {
                        logger.error(`[Chat-Only] Text-tool error: ${toolCall.toolName}`, toolError);
                        fullResponse += `\n\n<atlarix-tool-result tool="${toolCall.toolName}" status="error">\nError: ${toolError instanceof Error ? toolError.message : String(toolError)}\n</atlarix-tool-result>\n`;
                    }
                }

                safeSend(event.sender, "chat:response:chunk", {
                    chatId: req.chatId,
                    messages: [
                        ...chat.messages,
                        {
                            id: -1,
                            chatId: req.chatId,
                            role: "assistant",
                            content: fullResponse,
                            createdAt: new Date(),
                        },
                    ],
                });

                chatOnlyContinuationAttempts++;
                chatOnlyStreamMessages = [
                    ...chatOnlyStreamMessages,
                    // Strip <think> from history fed back to the model; the
                    // renderer stream above still carries the live tags.
                    { role: "assistant" as const, content: stripThinkBlocks(fullResponse) },
                    { role: "user" as const, content: "Please continue processing the request based on the tool results above." },
                ];

                // PASS8-FIX: Tool results are appended above (text-tool branch),
                // THEN prune, THEN compaction. Compaction never runs before the
                // current round's tool results land in chatOnlyStreamMessages.
                // PASS8 D1: Prune large tool outputs between rounds before compaction.
                chatOnlyStreamMessages = pruneToolOutputsInModelMessages(chatOnlyStreamMessages) as typeof chatOnlyStreamMessages;

                // PASS8 C1-C4: Compaction mirrored from Build into all agentic loops.
                {
                    const chatOnlyCompactionMid = await runMidLoopCompaction({
                        messages: chatOnlyStreamMessages,
                        systemPromptEstimate: estimateTokens(chatOnlyParts.stableHeader + "\n\n" + chatOnlyDynamicTail),
                        tierLimit: chatOnlyTierLimit,
                        contextWindowTokens: chatOnlyContextWindowTokens,
                        enabled: settings.enableContextAutoSummarize !== false,
                        chatId: req.chatId,
                        loopLabel: "chat-only",
                        emitActivity: (payload) =>
                            safeSend(event.sender, "chat:activity", payload),
                        onInfo: (msg) => logger.log(msg),
                        onWarn: (msg, err) => logger.warn(msg, err),
                    });
                    if (chatOnlyCompactionMid.compacted) {
                        chatOnlyStreamMessages = chatOnlyCompactionMid.messages as typeof chatOnlyStreamMessages;
                    }
                }
                fr = "unknown";
                continue;
            }

            if (
                !shouldContinue(fr, {
                    attemptCount: chatOnlyContinuationAttempts,
                    maxAttempts: CHAT_ONLY_CONTINUATION_MAX,
                }) ||
                abortController.signal.aborted
            ) {
                break;
            }
            chatOnlyContinuationAttempts++;
            const resp = await lastStreamResult.response;
            chatOnlyStreamMessages = [
                ...chatOnlyStreamMessages,
                ...(resp.messages as ModelMessage[]),
                {
                    role: "user",
                    content: buildContinuationPrompt({
                        chatId: req.chatId,
                        turnId: `chat-only-${req.chatId}`,
                        attemptCount: chatOnlyContinuationAttempts,
                        maxAttempts: CHAT_ONLY_CONTINUATION_MAX,
                        lastContent: stripThinkBlocks(fullResponse),
                    }),
                },
            ];

            // PASS8-FIX: Tool results are appended above (generic continuation
            // branch — SDK response.messages includes any native tool-result
            // entries), THEN prune, THEN compaction. Compaction never runs
            // before the current round's tool results land.
            // PASS8 D1: Prune large tool outputs between rounds before compaction.
            chatOnlyStreamMessages = pruneToolOutputsInModelMessages(chatOnlyStreamMessages) as typeof chatOnlyStreamMessages;

            // PASS8 C1-C4: Compaction mirrored from Build into all agentic loops.
            {
                const chatOnlyCompactionTail = await runMidLoopCompaction({
                    messages: chatOnlyStreamMessages,
                    systemPromptEstimate: estimateTokens(chatOnlyParts.stableHeader + "\n\n" + chatOnlyDynamicTail),
                    tierLimit: chatOnlyTierLimit,
                    contextWindowTokens: chatOnlyContextWindowTokens,
                    enabled: settings.enableContextAutoSummarize !== false,
                    chatId: req.chatId,
                    loopLabel: "chat-only",
                    emitActivity: (payload) =>
                        safeSend(event.sender, "chat:activity", payload),
                    onInfo: (msg) => logger.log(msg),
                    onWarn: (msg, err) => logger.warn(msg, err),
                });
                if (chatOnlyCompactionTail.compacted) {
                    chatOnlyStreamMessages = chatOnlyCompactionTail.messages as typeof chatOnlyStreamMessages;
                }
            }
        }

        if (!abortController.signal.aborted && !fullResponse.trim()) {
            fullResponse = AI_STREAM_EMPTY_RESPONSE_FALLBACK;
            safeSend(event.sender, "chat:response:chunk", {
                chatId: req.chatId,
                messages: [
                    ...chat.messages,
                    {
                        id: -1,
                        chatId: req.chatId,
                        role: "assistant",
                        content: fullResponse,
                        createdAt: new Date(),
                    },
                ],
            });
        }

        const { stripToolCallXML } = await import("../utils/text_tool_parser");
        fullResponse = stripToolCallXML(fullResponse);
        fullResponse = sanitizeAssistantOutput(fullResponse);

        const {
            cleanContent: contentAfterQuestions,
            questions,
            title: questionsTitle,
        } = parseQuestions(fullResponse);
        let responseToStore =
            questions != null ? contentAfterQuestions : fullResponse;
        responseToStore = sanitizeAssistantOutput(responseToStore);
        responseToStore = await summarizeOversizedToolResultsInContent(responseToStore, {
            settings,
            mainOptions,
        });
        // ═══════════════════════════════════════════════════════════════

        // Create assistant message (in-memory only) WITH SOURCES
        const rawSourceCount = collectedSources.length;
        const uniqueCollectedSources = dedupeCollectedSourcesByUrl(collectedSources);
        logger.log(
            `📊 Collected ${uniqueCollectedSources.length} unique sources from tool calls (raw ${rawSourceCount})`,
        );
        if (uniqueCollectedSources.length > 0) {
            logger.log("📚 Sources:", uniqueCollectedSources.map((s) => s.title).join(", "));
        }

        const assistantMessage: Message = {
            id: Date.now() + 1,
            chatId: req.chatId,
            role: "assistant",
            // Chat-only sessions are in-memory only, but the same model
            // sees this on subsequent turns (chat.messages -> messageHistory).
            // Strip <think> for parity with workspace DB persistence.
            content: stripThinkBlocks(responseToStore),
            sources: uniqueCollectedSources.length > 0 ? uniqueCollectedSources : undefined,
            createdAt: new Date(),
            ...(autoRoutedTierForTurn != null && { autoRoutedTier: autoRoutedTierForTurn }),
        };
        chat.messages.push(assistantMessage);

        if (questions != null && questions.length > 0) {
            safeSend(event.sender, "chat:questions", {
                messageId: assistantMessage.id,
                questions,
                ...(questionsTitle ? { title: questionsTitle } : {}),
            });
        }

        // Record exchange in session memory for conversation continuity
        try {
            const cleanResponse = responseToStore
                .replace(/<[^>]*>/g, '')
                .replace(/```[\s\S]*?```/g, '[code]')
                .trim();
            sessionMemory.addExchange(gatedPrompt, cleanResponse);
            logger.log(`Recorded exchange in session memory (now ${sessionMemory.getExchangeCount()} exchanges)`);
        } catch (error) {
            logger.warn("Failed to record session memory exchange:", error);
        }

        // Send final chunk with sources included so UI receives them
        safeSend(event.sender, "chat:response:chunk", {
            chatId: req.chatId,
            messages: [...chat.messages],
        });

        // Send completion
        const endResponse: ChatResponseEnd = {
            chatId: req.chatId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
            usedCompass: usedCompassThisStream,
            compassTier: compassTierForEnd,
            compassTokens: compassTokensForEnd,
            messages: [...chat.messages],
        } as ChatResponseEnd;
        safeSend(event.sender, "chat:response:end", endResponse);

        // Clean up
        activeStreams.delete(req.chatId);

        logger.log("Ephemeral chat-only stream completed successfully");
        return fullResponse;

    } catch (error) {
        logger.error("Error in ephemeral chat-only stream:", error);
        const noOutput = isNoUsableModelOutputError(error);
        const message = noOutput
            ? AI_STREAM_EMPTY_RESPONSE_FALLBACK
            : usedCompassThisStream
              ? COMPASS_REACHABILITY_ERROR
              : `Sorry, there was an error: ${error instanceof Error ? error.message : String(error)}`;
        safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            error: noOutput
                ? message
                : `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${message}`,
        });
        safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            updatedFiles: false,
            hadToolCallsOrPermissions: false,
            usedCompass: usedCompassThisStream,
            compassTier: compassTierForEnd,
        } satisfies ChatResponseEnd);
        activeStreams.delete(req.chatId);
        throw error;
    } finally {
        clearChatOnlyStreamingDraft(req.chatId);
    }
}

/**
 * Check if a chat is ephemeral (chat-only with no workspace)
 * Ephemeral chats have negative IDs
 */
export async function isChatOnly(chatId: number): Promise<boolean> {
    return isEphemeralChatId(chatId) || ephemeralChats.has(chatId);
}
