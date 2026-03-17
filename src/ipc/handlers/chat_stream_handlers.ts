import { v4 as uuidv4 } from "uuid";
import { ipcMain, IpcMainInvokeEvent } from "electron";
import {
  ModelMessage,
  TextPart,
  ImagePart,
  streamText,
  ToolSet,
  TextStreamPart,
  stepCountIs,
  hasToolCall,
} from "ai";

import { db } from "../../db";
import { apps, chats, messages, diagrams } from "../../db/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import type { SmartContextMode } from "../../lib/schemas";
import {
  constructSystemPrompt,
  readAiRules,
  buildSystemPromptWithProjectInstructions,
} from "../../prompts/system_prompt";
import {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT,
} from "../../prompts/supabase_prompt";
import { getAtlarixAppPath, resolveAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import type { ChatResponseEnd, ChatStreamParams } from "../ipc_types";
import {
  CodebaseFile,
  extractCodebase,
  readFileWithCache,
} from "../../utils/codebase";
import {
  dryRunSearchReplace,
  processFullResponseActions,
} from "../processors/response_processor";
import { streamTestResponse } from "./testing_chat_handlers";
import { getTestResponse } from "./testing_chat_handlers";
import { getModelClient, getEffectiveModel, getEffectiveModelForOptions, ModelClient, isDiagramModelNotFoundError, type GetModelClientOptions } from "../utils/get_model_client";
import log from "electron-log";
import {
  getSupabaseContext,
  getSupabaseClientCode,
} from "../../supabase_admin/supabase_context";
import { SUMMARIZE_CHAT_SYSTEM_PROMPT } from "../../prompts/summarize_chat_system_prompt";
import { SECURITY_REVIEW_SYSTEM_PROMPT } from "../../prompts/security_review_prompt";
import fs from "node:fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { readFile, writeFile, unlink } from "fs/promises";
import { getMaxTokens, getTemperature } from "../utils/token_utils";
import { MAX_CHAT_TURNS_IN_CONTEXT } from "@/constants/settings_constants";
import { validateChatContext } from "../utils/context_paths_utils";
import { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { mcpServers } from "../../db/schema";
import { requireMcpToolConsent } from "../utils/mcp_consent";

import { getExtraProviderOptions } from "../utils/thinking_utils";

import { safeSend } from "../utils/safe_sender";
import { cleanFullResponse, parseQuestions } from "../utils/cleanFullResponse";
import { generateProblemReport } from "../processors/tsc";
import { createProblemFixPrompt } from "@/shared/problem_prompt";
import { AsyncVirtualFileSystem } from "../../../shared/VirtualFilesystem";
import {
  getAtlarixWriteTags,
  getAtlarixDeleteTags,
  getAtlarixRenameTags,
} from "../utils/atlarix_tag_parser";
import { fileExists } from "../utils/file_utils";
import { FileUploadsState } from "../utils/file_uploads_state";
import { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { extractMentionedAppsCodebases } from "../utils/mention_apps";
import { parseAppMentions } from "@/shared/parse_mention_apps";
import { prompts as promptsTable } from "../../db/schema";
import { inArray } from "drizzle-orm";
import { replacePromptReference } from "../utils/replacePromptReference";
import { mcpManager } from "../utils/mcp_manager";
import { logMcpError } from "./mcp_handlers";
import z from "zod";
import { isTurboEditsV2Enabled } from "@/lib/schemas";
import { AI_STREAMING_ERROR_MESSAGE_PREFIX } from "@/shared/texts";
import { getCurrentCommitHash } from "../utils/git_utils";
import { createSnapshot, restoreSnapshot } from "../../lib/workspace-snapshots";
import { feedTerminalOutput } from "../../lib/streams/StreamManager";
import {
  processChatMessagesWithVersionedFiles as getVersionedFiles,
  VersionedFiles as VersionedFiles,
} from "../utils/versioned_codebase_context";
import {
  generateSimpleChatName,
  generateAIChatName,
  shouldTriggerAINaming,
} from "../../utils/chat_naming";
import { ToolRegistry } from "../../lib/tools";
import { generateManifest, isCoreTool } from "../../lib/tools/ToolManifest";
import { ToolSessionLoader } from "../../lib/tools/ToolSessionLoader";
import { handleChatOnlyStream } from "./chat_only_handlers";
import { getWorkspaceContext } from "./chat_stream/workspace-context";
import { buildWorkforceWorkspaceContextBlock } from "../../lib/workforce/WorkspaceContext";
import { PermissionInterceptor } from "./permissions/interceptor";
import { registerInterceptor } from "./permissions/handlers";
import { getSessionMemory, clearSessionMemory } from "../../lib/session-memory";
import {
  shouldCompact,
  runCompaction,
  getContextSummary,
  schedulePostTurnCompaction,
  pruneToolOutputsInMessages,
} from "../../lib/context-compaction";
import { readMemoryMd, readSpecMd, writeMemoryMd } from "../../lib/project-memory";
import { estimateTokens, getContextWindow } from "../utils/token_utils";
import { recordTrace } from "../../lib/agents/agent-lightning";
import { writeSettings } from "../../main/settings";

type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;

const logger = log.scope("chat_stream_handlers");

// v4.0 Progressive Tool Reveal: one loader per chat session
const toolSessionLoaders = new Map<number, ToolSessionLoader>();
function getOrCreateToolSessionLoader(chatId: number): ToolSessionLoader {
  let loader = toolSessionLoaders.get(chatId);
  if (!loader) {
    loader = new ToolSessionLoader((name) => ToolRegistry.get(name));
    toolSessionLoaders.set(chatId, loader);
  }
  return loader;
}

// Pending mode change (Ask -> Build) approval; keyed by chatId
const pendingModeChangeResolvers = new Map<number, { resolve: (approved: boolean) => void }>();

export function waitForModeChangeResponse(chatId: number): Promise<boolean> {
  return new Promise((resolve) => {
    pendingModeChangeResolvers.set(chatId, { resolve });
  });
}

export function resolveModeChange(chatId: number, approve: boolean): void {
  const r = pendingModeChangeResolvers.get(chatId);
  if (r) {
    pendingModeChangeResolvers.delete(chatId);
    r.resolve(approve);
  }
}

// ═══════════════════════════════════════════════════════════════
// SMART AGENTIC LOOP CONFIGURATION
// ═══════════════════════════════════════════════════════════════

interface AgenticLoopConfig {
  maxIterations: number;
  maxDurationMs: number;
  requireExplicitCompletion: boolean;
}

const DEFAULT_AGENTIC_CONFIG: AgenticLoopConfig = {
  maxIterations: 20,
  maxDurationMs: 10 * 60 * 1000, // 10 minutes
  requireExplicitCompletion: true,
};

/**
 * Detect if AI signals task completion.
 * Checks for explicit <task_complete> tag OR natural language patterns in the end of response.
 */
function isTaskComplete(response: string): boolean {
  // Explicit completion signal
  if (response.includes('<task_complete>')) return true;

  // Natural language patterns (must appear near end of response)
  const completionPatterns = [
    /task (is |has been )?completed successfully/i,
    /i('ve| have) completed (the |all )/i,
    /all done/i,
    /everything (is |has been )?(set up|ready|working)/i,
    /implementation (is )?complete/i,
    /successfully (created|built|implemented|set up)/i,
  ];

  const endOfResponse = response.slice(-500);
  return completionPatterns.some(pattern => pattern.test(endOfResponse));
}

/**
 * Wait for user to approve or decline continuation.
 * Properly cleans up listeners to prevent memory leaks.
 */
function waitForUserContinuation(
  chatId: number,
  timeout: number,
  defaultAction: boolean = true
): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = () => {
      ipcMain.removeListener(`chat:${chatId}:continue-approved`, handleApprove);
      ipcMain.removeListener(`chat:${chatId}:continue-declined`, handleDecline);
    };

    const timer = setTimeout(() => {
      logger.info(`[Agentic Loop] Continuation timeout, defaulting to: ${defaultAction}`);
      resolve(defaultAction);
      cleanup();
    }, timeout);

    const handleApprove = () => { clearTimeout(timer); resolve(true); cleanup(); };
    const handleDecline = () => { clearTimeout(timer); resolve(false); cleanup(); };

    ipcMain.once(`chat:${chatId}:continue-approved`, handleApprove);
    ipcMain.once(`chat:${chatId}:continue-declined`, handleDecline);
  });
}

// ═══════════════════════════════════════════════════════════════

// Track active streams for cancellation
const activeStreams = new Map<number, AbortController>();

// Track partial responses for cancelled streams
const partialResponses = new Map<number, string>();


/**
 * Abort all active AI streams - call on app quit to save tokens
 */
export function abortAllStreams(): void {
  const count = activeStreams.size;
  if (count === 0) return;

  logger.log(`[Cleanup] Aborting ${count} active AI streams to save tokens...`);

  for (const [chatId, controller] of activeStreams.entries()) {
    try {
      controller.abort();
      logger.log(`[Cleanup] Aborted stream for chat ${chatId}`);
    } catch (error) {
      logger.warn(`[Cleanup] Error aborting stream ${chatId}:`, error);
    }
  }

  activeStreams.clear();
  partialResponses.clear();
  logger.log(`[Cleanup] All AI streams aborted`);
}

// Directory for storing temporary files
const TEMP_DIR = path.join(os.tmpdir(), "dyad-attachments");

// Common helper functions
const TEXT_FILE_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".js",
  ".ts",
  ".html",
  ".css",
];

async function isTextFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.includes(ext);
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Safely parse an MCP tool key that combines server and tool names.
// We split on the LAST occurrence of "__" to avoid ambiguity if either
// side contains "__" as part of its sanitized name.
function parseMcpToolKey(toolKey: string): {
  serverName: string;
  toolName: string;
} {
  const separator = "__";
  const lastIndex = toolKey.lastIndexOf(separator);
  if (lastIndex === -1) {
    return { serverName: "", toolName: toolKey };
  }
  const serverName = toolKey.slice(0, lastIndex);
  const toolName = toolKey.slice(lastIndex + separator.length);
  return { serverName, toolName };
}

// Ensure the temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Helper function to process stream chunks
async function processStreamChunks({
  fullStream,
  fullResponse,
  abortController,
  chatId,
  processResponseChunkUpdate,
}: {
  fullStream: AsyncIterableStream<TextStreamPart<ToolSet>>;
  fullResponse: string;
  abortController: AbortController;
  chatId: number;
  processResponseChunkUpdate: (params: {
    fullResponse: string;
  }) => Promise<string>;
}): Promise<{ fullResponse: string; incrementalResponse: string }> {
  let incrementalResponse = "";
  let inThinkingBlock = false;

  for await (const part of fullStream) {
    let chunk = "";
    if (
      inThinkingBlock &&
      !["reasoning-delta", "reasoning-end", "reasoning-start"].includes(
        part.type,
      )
    ) {
      chunk = "</think>";
      inThinkingBlock = false;
    }
    if (part.type === "text-delta") {
      chunk += part.text;
    } else if (part.type === "reasoning-delta") {
      if (!inThinkingBlock) {
        chunk = "<think>";
        inThinkingBlock = true;
      }

      chunk += escapeAtlarixTags(part.text);
    } else if (part.type === "tool-call") {
      const { serverName, toolName } = parseMcpToolKey(part.toolName);
      const content = escapeAtlarixTags(JSON.stringify(part.input));
      // Use native tags for non-MCP tools (serverName is empty or matches toolName)
      if (!serverName || serverName === toolName) {
        // Native tool (from ToolRegistry - Ask mode)
        chunk = `<atlarix-tool-call tool="${toolName}" status="running">\n${content}\n</atlarix-tool-call>\n`;
      } else {
        // MCP tool (from external MCP server)
        chunk = `<atlarix-mcp-tool-call server="${serverName}" tool="${toolName}">\n${content}\n</atlarix-mcp-tool-call>\n`;
      }
    } else if (part.type === "tool-result") {
      const { serverName, toolName } = parseMcpToolKey(part.toolName);
      const content = escapeAtlarixTags(part.output);
      // Use native tags for non-MCP tools
      if (!serverName || serverName === toolName) {
        // Native tool result
        chunk = `<atlarix-tool-result tool="${toolName}" status="complete">\n${content}\n</atlarix-tool-result>\n`;
      } else {
        // MCP tool result
        chunk = `<atlarix-mcp-tool-result server="${serverName}" tool="${toolName}">\n${content}\n</atlarix-mcp-tool-result>\n`;
      }
    }

    if (!chunk) {
      continue;
    }

    fullResponse += chunk;
    incrementalResponse += chunk;
    fullResponse = cleanFullResponse(fullResponse);
    fullResponse = await processResponseChunkUpdate({
      fullResponse,
    });

    // If the stream was aborted, exit early
    if (abortController.signal.aborted) {
      logger.log(`Stream for chat ${chatId} was aborted`);
      break;
    }
  }

  return { fullResponse, incrementalResponse };
}

export function registerChatStreamHandlers() {
  ipcMain.handle(
    "respond-mode-change",
    async (
      _event,
      payload: { chatId: number; approve: boolean }
    ): Promise<{ ok: boolean }> => {
      const { chatId, approve } = payload;
      resolveModeChange(chatId, approve);
      if (approve) {
        writeSettings({ selectedChatMode: "build", intentMode: "build" });
      }
      return { ok: true };
    }
  );

  ipcMain.handle("chat:stream", async (event, req: ChatStreamParams) => {
    const abortController = new AbortController();
    activeStreams.set(req.chatId, abortController);

    const runStream = async () => {
      try {
        const fileUploadsState = FileUploadsState.getInstance();
        let dyadRequestId: string | undefined;
        let hadToolCallsOrPermissions = false;

        // Check if this is an ephemeral (incognito) chat BEFORE querying database
        const { isEphemeralChatId, getEphemeralChatAppId } = await import("./chat_only_handlers");

        if (isEphemeralChatId(req.chatId)) {
          // Check if this ephemeral chat is associated with a workspace
          const ephemeralAppId = getEphemeralChatAppId(req.chatId);

          if (ephemeralAppId) {
            // This is an ephemeral WORKSPACE chat - has workspace context
            logger.log(`Chat ${req.chatId} is ephemeral workspace chat for app: ${ephemeralAppId}`);
            // Continue below to use workspace-aware handler with the ephemeral appId
          } else {
            // This is a pure chat-only (no workspace) - use simplified handler with global MCP tools
            logger.log(`Chat ${req.chatId} is ephemeral chat-only mode (incognito)`);
            const mcpTools = await getMcpTools(event, null);
            await handleChatOnlyStream(event, req, abortController, mcpTools);
            return;
          }
        }

      // Get app for ephemeral workspace chats or regular DB chats
      let chat: any;
      let appData: any;

      if (isEphemeralChatId(req.chatId)) {
        // Ephemeral workspace chat - get app from DB using the stored appId
        const ephemeralAppId = getEphemeralChatAppId(req.chatId);
        const { getEphemeralChat } = await import("./chat_only_handlers");
        const ephemeralChat = getEphemeralChat(req.chatId);

        appData = await db.query.apps.findFirst({
          where: eq(apps.id, ephemeralAppId!),
        });

        if (!appData) {
          throw new Error(`App not found for ephemeral workspace chat: ${ephemeralAppId}`);
        }

        // Create a chat-like object for compatibility
        chat = {
          id: req.chatId,
          appId: ephemeralAppId,
          title: ephemeralChat?.title || "New Chat",
          messages: ephemeralChat?.messages || [],
          app: appData,
          initialCommitHash: null,
          lastUsedAt: new Date(),
          hasAnsweredQuestions: false,
        };

        logger.log(`Ephemeral workspace chat loaded for app: ${appData.name} (${appData.path})`);
      } else {
        // Get the chat from database (for regular chats)
        chat = await db.query.chats.findFirst({
          where: eq(chats.id, req.chatId),
          with: {
            messages: {
              orderBy: (messages, { asc }) => [asc(messages.createdAt)],
            },
            app: true, // Include app information
          },
        });

        if (!chat) {
          throw new Error(`Chat not found: ${req.chatId}`);
        }

        // Chat-only mode: route to simplified handler (no workspace/codebase) with global MCP tools
        if (!chat.app) {
          logger.log(`Chat ${req.chatId} is chat-only mode (no workspace)`);
          const mcpTools = await getMcpTools(event, null);
          await handleChatOnlyStream(event, req, abortController, mcpTools);
          return;
        }

        appData = chat.app;
      }

      // Handle redo option: remove the most recent messages if needed
      if (req.redo) {
        // Get the most recent messages
        const chatMessages = [...chat.messages];

        // Find the most recent user message
        let lastUserMessageIndex = chatMessages.length - 1;
        while (
          lastUserMessageIndex >= 0 &&
          chatMessages[lastUserMessageIndex].role !== "user"
        ) {
          lastUserMessageIndex--;
        }

        if (lastUserMessageIndex >= 0) {
          // Delete the user message
          await db
            .delete(messages)
            .where(eq(messages.id, chatMessages[lastUserMessageIndex].id));

          // If there's an assistant message after the user message, delete it too
          if (
            lastUserMessageIndex < chatMessages.length - 1 &&
            chatMessages[lastUserMessageIndex + 1].role === "assistant"
          ) {
            await db
              .delete(messages)
              .where(
                eq(messages.id, chatMessages[lastUserMessageIndex + 1].id),
              );
          }
        }
      }

      // v3.9: Continue after clarifying questions — use last user message (already updated with Q/A block)
      let userPrompt: string;
      if (req.continueAfterQuestions) {
        // Re-fetch chat so we have the user message that was updated by chat:submit-question-answers
        const freshChat = await db.query.chats.findFirst({
          where: eq(chats.id, req.chatId),
          with: {
            messages: { orderBy: (messages, { asc }) => [asc(messages.createdAt)] },
            app: true,
          },
        });
        if (!freshChat) throw new Error("Chat not found");
        const userMessages = freshChat.messages.filter((m: any) => m.role === "user");
        const lastUser = userMessages[userMessages.length - 1];
        if (!lastUser?.content) {
          throw new Error("Continue after questions: no user message content found");
        }
        userPrompt = lastUser.content;
      }

      // Process attachments if any (skip when continuing after questions)
      let attachmentInfo = "";
      let attachmentPaths: string[] = [];

      if (!req.continueAfterQuestions && req.attachments && req.attachments.length > 0) {
        attachmentInfo = "\n\nAttachments:\n";

        for (const [index, attachment] of req.attachments.entries()) {
          // Generate a unique filename
          const hash = crypto
            .createHash("md5")
            .update(attachment.name + Date.now())
            .digest("hex");
          const fileExtension = path.extname(attachment.name);
          const filename = `${hash}${fileExtension}`;
          const filePath = path.join(TEMP_DIR, filename);

          // Extract the base64 data (remove the data:mime/type;base64, prefix)
          const base64Data = attachment.data.split(";base64,").pop() || "";

          await writeFile(filePath, Buffer.from(base64Data, "base64"));
          attachmentPaths.push(filePath);

          if (attachment.attachmentType === "upload-to-codebase") {
            // For upload-to-codebase, create a unique file ID and store the mapping
            const fileId = `DYAD_ATTACHMENT_${index}`;

            fileUploadsState.addFileUpload(
              { chatId: req.chatId, fileId },
              {
                filePath,
                originalName: attachment.name,
              },
            );

            // Add instruction for AI to use atlarix-write tag
            attachmentInfo += `\n\nFile to upload to codebase: ${attachment.name} (file id: ${fileId})\n`;
          } else {
            // For chat-context, use the existing logic
            attachmentInfo += `- ${attachment.name} (${attachment.type})\n`;
            // If it's a text-based file, try to include the content
            if (await isTextFile(filePath)) {
              try {
                attachmentInfo += `<atlarix-text-attachment filename="${attachment.name}" type="${attachment.type}" path="${filePath}">
                </atlarix-text-attachment>
                \n\n`;
              } catch (err) {
                logger.error(`Error reading file content: ${err}`);
              }
            }
          }
        }
      }

      // Add user message to database with attachment info (skip when continueAfterQuestions)
      if (!req.continueAfterQuestions) {
        userPrompt = req.prompt + (attachmentInfo ? attachmentInfo : "");
      }
      // Inline referenced prompt contents for mentions like @prompt:<id> (skip when continueAfterQuestions)
      if (!req.continueAfterQuestions) {
        try {
          const matches = Array.from(userPrompt.matchAll(/@prompt:(\d+)/g));
          if (matches.length > 0) {
            const ids = Array.from(new Set(matches.map((m) => Number(m[1]))));
            const referenced = await db
              .select()
              .from(promptsTable)
              .where(inArray(promptsTable.id, ids));
            if (referenced.length > 0) {
              const promptsMap: Record<number, string> = {};
              for (const p of referenced) {
                promptsMap[p.id] = p.content;
              }
              userPrompt = replacePromptReference(userPrompt, promptsMap);
            }
          }
        } catch (e) {
          logger.error("Failed to inline referenced prompts:", e);
        }
      }

      const componentsToProcess = req.continueAfterQuestions ? [] : (req.selectedComponents || []);

      if (componentsToProcess.length > 0) {
        userPrompt += "\n\nSelected components:\n";

        for (const component of componentsToProcess) {
          let componentSnippet = "[component snippet not available]";
          try {
            const componentFileContent = await readFile(
              path.join(resolveAppPath(chat.app.path), component.relativePath),
              "utf8",
            );
            const lines = componentFileContent.split(/\r?\n/);
            const selectedIndex = component.lineNumber - 1;

            // Let's get one line before and three after for context.
            const startIndex = Math.max(0, selectedIndex - 1);
            const endIndex = Math.min(lines.length, selectedIndex + 4);

            const snippetLines = lines.slice(startIndex, endIndex);
            const selectedLineInSnippetIndex = selectedIndex - startIndex;

            if (snippetLines[selectedLineInSnippetIndex]) {
              snippetLines[selectedLineInSnippetIndex] =
                `${snippetLines[selectedLineInSnippetIndex]} // <-- EDIT HERE`;
            }

            componentSnippet = snippetLines.join("\n");
          } catch (err) {
            logger.error(
              `Error reading selected component file content: ${err}`,
            );
          }

          userPrompt += `\n${componentsToProcess.length > 1 ? `${componentsToProcess.indexOf(component) + 1}. ` : ""}Component: ${component.name} (file: ${component.relativePath})

Snippet:
\`\`\`
${componentSnippet}
\`\`\`
`;
        }
      }

      // Check if this is an ephemeral workspace chat (skip DB writes)
      const isEphemeralWorkspace = isEphemeralChatId(req.chatId);

      // Only save user message to database for non-ephemeral chats (skip when continueAfterQuestions — user message already updated)
      if (!isEphemeralWorkspace && !req.continueAfterQuestions) {
        await db
          .insert(messages)
          .values({
            chatId: req.chatId,
            role: "user",
            content: userPrompt,
          })
          .returning();
      }
      const settings = readSettings();
      // Only Atlarix Pro requests have request ids.
      if (settings.enableAtlarixPro) {
        // Generate requestId early so it can be saved with the message
        dyadRequestId = uuidv4();
      }

      // Add a placeholder assistant message immediately
      // For ephemeral chats, we'll use a placeholder ID
      let placeholderAssistantMessage: any = { id: Date.now() }; // Default for ephemeral
      let updatedChat: any = chat; // Use the existing chat object for ephemeral

      if (!isEphemeralWorkspace) {
        // v3.9: 0-based exchange index = number of assistant messages before this one
        const exchangeIndex =
          chat.messages.filter((m: any) => m.role === "assistant").length;
        // Regular DB chat - save to database
        const [dbPlaceholder] = await db
          .insert(messages)
          .values({
            chatId: req.chatId,
            role: "assistant",
            content: "", // Start with empty content
            requestId: dyadRequestId,
            sourceCommitHash: await getCurrentCommitHash({
              path: resolveAppPath(chat.app.path),
            }),
            exchangeIndex,
          })
          .returning();
        placeholderAssistantMessage = dbPlaceholder;

        // Fetch updated chat data after possible deletions and additions
        const fetchedChat = await db.query.chats.findFirst({
          where: eq(chats.id, req.chatId),
          with: {
            messages: {
              orderBy: (messages, { asc }) => [asc(messages.createdAt)],
            },
            app: true, // Include app information
          },
        });

        if (!fetchedChat) {
          throw new Error(`Chat not found: ${req.chatId}`);
        }
        updatedChat = fetchedChat;

        // Update lastUsedAt timestamp for chat activity
        await db
          .update(chats)
          .set({ lastUsedAt: new Date() })
          .where(eq(chats.id, req.chatId));

        // Hybrid Chat Naming Logic
        const messageCount = updatedChat.messages.length;

        // On first user message (2 messages total: user + assistant placeholder)
        // Generate simple keyword-based name
        if (messageCount === 2 && !chat.title) {
          const firstUserMessage = updatedChat.messages.find((m: any) => m.role === "user");
          if (firstUserMessage) {
            const simpleName = generateSimpleChatName(firstUserMessage.content);
            await db
              .update(chats)
              .set({ title: simpleName })
              .where(eq(chats.id, req.chatId));
            logger.info(`Generated simple chat name: "${simpleName}" for chat ${req.chatId}`);
          }
        }

        // After 2 user-assistant exchanges (4+ messages), trigger AI naming
        // This will replace the simple keyword-based name with an AI-generated one
        if (shouldTriggerAINaming(messageCount)) {
          try {
            const currentTitle = chat.title || "New Chat";
            const conversationMessages = updatedChat.messages.map((m: any) => ({
              role: m.role,
              content: m.content,
            }));

            const aiName = await generateAIChatName(conversationMessages, currentTitle);

            if (aiName !== currentTitle) {
              await db
                .update(chats)
                .set({ title: aiName })
                .where(eq(chats.id, req.chatId));
              logger.info(`Updated chat ${req.chatId} with AI name: "${aiName}"`);
            }
          } catch (error) {
            logger.error(`Failed to generate AI chat name: ${error}`);
            // Fallback to keeping the simple keyword-based name
          }
        }
      } else {
        // Ephemeral workspace chat - no DB operations
        logger.log(`Ephemeral workspace chat ${req.chatId} - skipping DB operations`);
        const { addEphemeralMessage, getEphemeralChat } = await import("./chat_only_handlers");
        // Build from current store WITHOUT adding the new user message yet to avoid duplication
        const ephemeralChat = getEphemeralChat(req.chatId);
        const existingMessages = ephemeralChat?.messages || [];

        const newUserMessage = {
          id: Date.now(),
          chatId: req.chatId,
          role: "user",
          content: userPrompt,
          createdAt: new Date(),
          sourceCommitHash: null,
          commitHash: null,
        };
        const placeholderMessage = {
          id: Date.now() + 1,
          chatId: req.chatId,
          role: "assistant",
          content: "", // Empty - will be filled by streaming
          createdAt: new Date(),
          sourceCommitHash: null,
          commitHash: null,
        };

        updatedChat.messages = [...existingMessages, newUserMessage, placeholderMessage];
        placeholderAssistantMessage = placeholderMessage;
      }

      // Send the messages right away so that the loading state is shown for the message.
      safeSend(event.sender, "chat:response:chunk", {
        chatId: req.chatId,
        messages: updatedChat.messages,
      });

      // After building and sending, persist the new user message for ephemeral so next request sees it
      if (req.chatId < 0) {
        const { addEphemeralMessage } = await import("./chat_only_handlers");
        addEphemeralMessage(req.chatId, { role: "user", content: userPrompt });
      }

      let fullResponse = "";
      let maxTokensUsed: number | undefined;

      // Check if this is a test prompt
      const testResponse = getTestResponse(req.prompt);

      if (testResponse) {
        // For test prompts, use the dedicated function
        fullResponse = await streamTestResponse(
          event,
          req.chatId,
          testResponse,
          abortController,
          updatedChat,
        );
      } else {
        // Normal AI processing for non-test prompts
        const mainOptions: GetModelClientOptions = {
          agentMode: settings.agentMode ?? "guided",
          delegationRole: "main",
        };
        let effectiveModel = getEffectiveModel(settings);
        if (req.modelOverride) {
          effectiveModel = req.modelOverride;
        } else if (settings.autoModelRouting && effectiveModel.provider === "auto") {
          const { runAutoRouter } = await import("../../lib/routing/auto-router");
          const { decision, model } = runAutoRouter(req.prompt, settings, mainOptions);
          effectiveModel = model;
          if (settings.autoRoutingShowReasoning !== false) {
            safeSend(event.sender, "chat:activity", {
              id: `routing-${req.chatId}-${Date.now()}`,
              type: "routing_decision",
              label: `Auto → ${decision.targetModel} (${decision.category})`,
              status: "done",
              timestamp: Date.now(),
              chatId: req.chatId,
            });
          }
        }
        const { modelClient, isEngineEnabled, isSmartContextEnabled } =
          await getModelClient(effectiveModel, settings, mainOptions);

        // Resolve effective workspace: sidebar selection (req.appId) overrides when present and different from chat's app
        let effectiveApp = updatedChat.app;
        if (req.appId != null && req.appId !== updatedChat.app?.id) {
          const overrideApp = await db.query.apps.findFirst({
            where: eq(apps.id, req.appId),
          });
          if (overrideApp) effectiveApp = overrideApp;
        }
        const hasWorkspace = !!effectiveApp;
        let appPath = effectiveApp?.path ? resolveAppPath(effectiveApp.path) : "";
        const effectiveAppId = effectiveApp?.id;
        logger.log(
          `Using workspace for chat ${req.chatId}: ${appPath || "(none)"} (appId: ${effectiveAppId ?? req.appId ?? "n/a"})`,
        );

        let codebaseInfo = "";
        let files: any[] = [];
        let chatContext: any = { contextPaths: [], smartContextAutoIncludes: [] };

        if (hasWorkspace) {
          // When we don't have smart context enabled, we
          // only include the selected components' files for codebase context.
          //
          // If we have selected components and smart context is enabled,
          // we handle this specially below.
          chatContext =
            req.selectedComponents &&
              req.selectedComponents.length > 0 &&
              !isSmartContextEnabled
              ? {
                contextPaths: req.selectedComponents.map((component) => ({
                  globPath: component.relativePath,
                })),
                smartContextAutoIncludes: [],
              }
              : validateChatContext(effectiveApp!.chatContext);

          // --- DIAGRAM-FIRST CONTEXT SYSTEM ---
          // Instead of extracting full codebase (168K+ tokens), we:
          // 1. Inject diagram context via getWorkspaceContext() (below at line ~700)
          // 2. Let AI use file tools (read_file, search_code, list_files) on demand
          // This reduces context from ~168K to ~3-4K tokens (97% reduction)

          // Note: files array kept for backward compatibility with selected components
          // but no longer used for full codebase dump
          files = [];
          codebaseInfo = ""; // Diagram context injected via systemPrompt instead

          // For smart context and selected components, we will mark the selected components' files as focused.
          // This means that we don't do the regular smart context handling, but we'll allow fetching
          // additional files through <atlarix-read> as needed.
          if (
            isSmartContextEnabled &&
            req.selectedComponents &&
            req.selectedComponents.length > 0
          ) {
            const selectedPaths = new Set(
              req.selectedComponents.map((component) => component.relativePath),
            );
            for (const file of files) {
              if (selectedPaths.has(file.path)) {
                file.focused = true;
              }
            }
          }
        }

        // Parse app mentions from the prompt
        const mentionedAppNames = parseAppMentions(req.prompt);

        // Extract codebases for mentioned apps
        const mentionedAppsCodebases = await extractMentionedAppsCodebases(
          mentionedAppNames,
          effectiveAppId ?? 0, // Exclude current effective app
        );

        const isDeepContextEnabled =
          isEngineEnabled &&
          settings.enableProSmartFilesContextMode &&
          // Anything besides balanced will use deep context.
          settings.proSmartContextOption !== "balanced" &&
          mentionedAppsCodebases.length === 0;
        logger.log(`isDeepContextEnabled: ${isDeepContextEnabled}`);

        // Combine current app codebase with mentioned apps' codebases
        let otherAppsCodebaseInfo = "";
        if (mentionedAppsCodebases.length > 0) {
          const mentionedAppsSection = mentionedAppsCodebases
            .map(
              ({ appName, codebaseInfo }) =>
                `\n\n=== Referenced App: ${appName} ===\n${codebaseInfo}`,
            )
            .join("");

          otherAppsCodebaseInfo = mentionedAppsSection;

          logger.log(
            `Added ${mentionedAppsCodebases.length} mentioned app codebases`,
          );
        }

        if (hasWorkspace) {
          logger.log(`Extracted codebase information from ${appPath}`);
          logger.log(
            "codebaseInfo: length",
            codebaseInfo.length,
            "estimated tokens",
            codebaseInfo.length / 4,
          );

          // ═══════════════════════════════════════════════════════════════
          // COLD START: Background diagram generation for new workspaces
          // Start non-blocking generation if no diagram exists yet
          // ═══════════════════════════════════════════════════════════════
          const workspaceId = effectiveAppId;
          if (workspaceId) {
            try {
              const { DiagramManager } = await import("../../lib/DiagramManager");
              const hasDiagram = await DiagramManager.hasAnyDiagram(workspaceId);

              if (!hasDiagram && !DiagramManager.isGenerating(workspaceId)) {
                logger.info(`[Cold Start] Starting background diagram generation for workspace ${workspaceId}`);

                // Start background generation (non-blocking - don't await)
                DiagramManager.generateInitialDiagram(workspaceId, appPath)
                  .then((diagram) => {
                    logger.info(`[Cold Start] Initial diagram ready for workspace ${workspaceId}`);
                    // Notify renderer that diagram is ready
                    safeSend(event.sender, "diagram:initial-ready", {
                      workspaceId,
                      diagramId: diagram.id,
                      title: diagram.title,
                    });
                  })
                  .catch((err) => {
                    logger.error(`[Cold Start] Background diagram generation failed:`, err);
                  });
              } else if (DiagramManager.isGenerating(workspaceId)) {
                logger.info(`[Cold Start] Diagram generation already in progress for workspace ${workspaceId}`);
              }
            } catch (coldStartError) {
              logger.warn("[Cold Start] Failed to check/start diagram generation:", coldStartError);
            }
          }

          // Prepare message history for the AI
          // Note: For ephemeral messages, sourceCommitHash and commitHash may be undefined
          // We only include them if they have actual values to avoid confusing the AI SDK
          const messageHistory = updatedChat.messages.map((message) => {
            const content = message.content || "";
            const baseMessage: { role: "user" | "assistant" | "system"; content: string } = {
              role: message.role as "user" | "assistant" | "system",
              content,
            };

            // Only include commit hash fields if they're defined (DB messages have them, ephemeral don't)
            // These are used for Atlarix Pro engine features
            const commitFields: { sourceCommitHash?: string; commitHash?: string } = {};
            if (message.sourceCommitHash) {
              commitFields.sourceCommitHash = message.sourceCommitHash;
            }
            if (message.commitHash) {
              commitFields.commitHash = message.commitHash;
            }

            return { ...baseMessage, ...commitFields };
          });


          // Phase 6: Context bar + auto-summarize OR fallback to turn truncation
          const useAutoSummarize =
            settings.enableContextAutoSummarize !== false &&
            req.chatId > 0 &&
            !isEphemeralWorkspace;

          let limitedMessageHistory = messageHistory;
          let contextSummaryForSystem: string | null = null;

          if (useAutoSummarize) {
            const msgList = updatedChat.messages as { id: number; role: string; content: string }[];
            const messageHistoryTokens = msgList.reduce(
              (acc, m) => acc + estimateTokens(m.content || ""),
              0
            );
            const systemPromptEstimate = 6000; // Conservative: base + diagram + session memory
            const inputTokens = estimateTokens(userPrompt);

            // Check for existing summary
            const existingSummary = await getContextSummary(req.chatId);
            if (existingSummary) {
              contextSummaryForSystem = existingSummary.summaryText;
              const afterSummary = msgList.filter((m) => m.id > existingSummary.lastMessageId);
              limitedMessageHistory = afterSummary.map((m) => ({
                role: m.role as "user" | "assistant" | "system",
                content: m.content || "",
              }));
              logger.log(
                `Using context summary + ${afterSummary.length} messages (after msg ${existingSummary.lastMessageId})`,
              );
            } else {
              const toolCallsInLast6 = msgList
                .slice(-6)
                .filter((m) => (m.content || "").includes("tool_result") || (m.content || "").includes("tool_use"))
                .length;
              const toolCallCount = msgList.filter(
                (m) => (m.content || "").includes("tool_result") || (m.content || "").includes("tool_use")
              ).length;
              const delegationCount = msgList.filter(
                (m) => (m.content || "").includes("delegate_to_agent") || (m.content || "").includes("delegation")
              ).length;
              const shouldRun = await shouldCompact({
                chatId: req.chatId,
                messageHistoryTokens,
                systemPromptTokens: systemPromptEstimate,
                inputTokens,
                providerId: getEffectiveModelForOptions(settings)?.provider,
                exchangeCount: msgList.length,
                toolCallsInLast6,
                hasWorkspace: !!hasWorkspace,
              });
              if (shouldRun) {
              // Emit "running" so frontend can show summarization progress above input
              safeSend(event.sender, "chat:activity", {
                id: `compaction-start-${req.chatId}-${Date.now()}`,
                type: "background",
                label: "Summarizing conversation",
                status: "running",
                timestamp: Date.now(),
                chatId: req.chatId,
              });
              // Run compaction when over threshold
              const compactionResult = await runCompaction({
                chatId: req.chatId,
                chatMessages: msgList.map((m) => ({ id: m.id, role: m.role, content: m.content || "" })),
                systemPromptTokens: systemPromptEstimate,
                inputTokens,
                providerId: getEffectiveModelForOptions(settings)?.provider,
                sessionStats: { toolCallCount, delegationCount },
              });
              if (compactionResult) {
                contextSummaryForSystem = compactionResult.summaryText;
                limitedMessageHistory = compactionResult.messagesAfterSummary.map((m) => ({
                  role: m.role as "user" | "assistant" | "system",
                  content: m.content || "",
                }));
                logger.log(
                  `Compaction complete: ${compactionResult.messagesAfterSummary.length} messages after summary`,
                );
                safeSend(event.sender, "chat:activity", {
                  id: `compaction-${req.chatId}-${Date.now()}`,
                  type: "background",
                  label: "Summarizing conversation",
                  status: "done",
                  timestamp: Date.now(),
                  detail: `Compacted to ${compactionResult.messagesAfterSummary.length} messages`,
                  chatId: req.chatId,
                });
                // Persist to .atlarix/memory.md for cross-session memory
                if (hasWorkspace && appPath) {
                  writeMemoryMd(appPath, compactionResult.summaryText).catch((err) =>
                    logger.warn("Failed to write .atlarix/memory.md:", err)
                  );
                }
              }
              }
            }
          }

          // Fallback: turn-based truncation (when auto-summarize off or for ephemeral)
          if (!useAutoSummarize) {
            const maxChatTurns = isDeepContextEnabled
              ? 201
              : (settings.maxChatTurnsInContext || MAX_CHAT_TURNS_IN_CONTEXT) + 1;

            if (messageHistory.length > maxChatTurns * 2) {
              let recentMessages = messageHistory
                .filter((msg) => msg.role !== "system")
                .slice(-maxChatTurns * 2);

              if (recentMessages.length > 0 && recentMessages[0].role !== "user") {
                const firstUserIndex = recentMessages.findIndex((msg) => msg.role === "user");
                if (firstUserIndex > 0) {
                  recentMessages = recentMessages.slice(firstUserIndex);
                } else if (firstUserIndex === -1) {
                  recentMessages = [];
                }
              }
              limitedMessageHistory = [...recentMessages];
              logger.log(
                `Limiting chat history from ${messageHistory.length} to ${limitedMessageHistory.length} messages (max ${maxChatTurns} turns)`,
              );
            }
          }

          const contextSize = Math.min(await getContextWindow(), 128_000);
          const chatMode =
            settings.selectedChatMode === "agent"
              ? "build"
              : settings.selectedChatMode;
          let systemPrompt: string;
          if (hasWorkspace && appPath && effectiveAppId != null) {
            const workspacePromptRow = await db.query.prompts.findFirst({
              where: and(
                eq(promptsTable.type, "workspace"),
                eq(promptsTable.workspaceId, effectiveAppId),
              ),
            });
            systemPrompt = await buildSystemPromptWithProjectInstructions({
              workspacePath: appPath,
              workspacePromptContent: workspacePromptRow?.content ?? null,
              contextSize,
              chatMode,
              userPrompt: userPrompt,
              hasAnsweredQuestions: updatedChat?.hasAnsweredQuestions ?? false,
            });
          } else {
            systemPrompt = constructSystemPrompt({
              aiRules: await readAiRules(resolveAppPath(updatedChat.app?.path ?? "")),
              chatMode,
              contextSize,
              userPrompt,
              enableTurboEditsV2: isTurboEditsV2Enabled(settings),
              hasAnsweredQuestions: updatedChat?.hasAnsweredQuestions ?? false,
            });
          }

          // Inject workspace analysis context (diagram-first analysis)
          // This prevents AI hallucination by providing accurate structure info
          try {
            const workspaceContext = await getWorkspaceContext(appPath);
            if (workspaceContext) {
              systemPrompt += workspaceContext.systemPromptAddition;
              logger.info(`Injected workspace context (fromCache: ${workspaceContext.fromCache})`);

              // Send diagram to renderer for RightPanel display
              safeSend(event.sender, "chat:workspace-diagram", {
                chatId: req.chatId,
                diagram: workspaceContext.diagram,
                summary: workspaceContext.summary,
              });

              // Save diagram to database for Diagrams page (only if not from cache to avoid duplicates)
              if (!workspaceContext.fromCache && workspaceContext.diagram) {
                try {
                  // For ephemeral chats (negative IDs), don't save chatId (FK constraint would fail)
                  const isEphemeralChat = req.chatId < 0;
                  await db.insert(diagrams).values({
                    workspaceId: effectiveAppId ?? req.appId ?? null,
                    chatId: isEphemeralChat ? null : req.chatId,
                    type: "architecture",
                    title: `Architecture - ${workspaceContext.summary}`,
                    content: workspaceContext.diagram,
                    metadata: { summary: workspaceContext.summary },
                  });
                  logger.info(`Saved workspace diagram to database for appId: ${effectiveAppId ?? req.appId}`);
                } catch (dbError) {
                  logger.warn("Failed to save diagram to database:", dbError);
                }
              }
            }

            // v4.0 Workforce: inject Workspace Context block (connected extensions) for Workforce tier only
            try {
              const workforceBlock = await buildWorkforceWorkspaceContextBlock();
              if (workforceBlock) {
                systemPrompt += workforceBlock;
                logger.info("Injected Workforce workspace context block");
              }
            } catch (workforceErr) {
              logger.warn("Failed to build Workforce workspace context:", workforceErr);
            }
          } catch (error) {
            logger.warn("Failed to inject workspace context:", error);
          }

          // Project-level .atlarix/memory.md and .atlarix/spec.md – Claude Code style
          if (hasWorkspace && appPath) {
            try {
              const memoryMd = await readMemoryMd(appPath);
              if (memoryMd) {
                systemPrompt += `\n\n## Project memory (cross-session)\n${memoryMd}`;
                logger.info("Injected .atlarix/memory.md");
              }
              const specMd = await readSpecMd(appPath);
              if (specMd) {
                systemPrompt += `\n\n## Task breakdown (spec.md)\n${specMd}`;
                logger.info("Injected .atlarix/spec.md");
              }
            } catch (memErr) {
              logger.warn("Failed to read .atlarix/memory.md or spec.md:", memErr);
            }
          }

          // Phase 6: Inject context summary (compacted earlier conversation)
          if (contextSummaryForSystem) {
            systemPrompt += `\n\n## Session Summary (earlier conversation)\n${contextSummaryForSystem}`;
            logger.info("Injected context summary from auto-compaction");
          }

          // Inject session memory (last 5 exchanges for conversation continuity)
          // NOTE: Use appId (workspace ID) as key so memory persists across mode switches (Ask → Build)
          try {
            const sessionMemory = getSessionMemory(chat.appId);
            const sessionContext = sessionMemory.getContextForPrompt();
            if (sessionContext) {
              systemPrompt += `\n\n${sessionContext}`;
              logger.info(`Injected session memory (${sessionMemory.getExchangeCount()} exchanges, ~${sessionMemory.estimateTokens()} tokens)`);
            }
          } catch (error) {
            logger.warn("Failed to inject session memory:", error);
          }
          // Add information about mentioned apps if any
          if (otherAppsCodebaseInfo) {
            const mentionedAppsList = mentionedAppsCodebases
              .map(({ appName }) => appName)
              .join(", ");

            systemPrompt += `\n\n# Referenced Apps\nThe user has mentioned the following apps in their prompt: ${mentionedAppsList}. Their codebases have been included in the context for your reference. When referring to these apps, you can understand their structure and code to provide better assistance, however you should NOT edit the files in these referenced apps. The referenced apps are NOT part of the current app and are READ-ONLY.`;
          }

          const isSecurityReviewIntent =
            req.prompt.startsWith("/security-review");
          if (isSecurityReviewIntent) {
            systemPrompt = SECURITY_REVIEW_SYSTEM_PROMPT;
            try {
              const rulesPath = path.join(appPath, "SECURITY_RULES.md");
              let securityRules = "";

              await fs.promises.access(rulesPath);
              securityRules = await fs.promises.readFile(rulesPath, "utf8");

              if (securityRules && securityRules.trim().length > 0) {
                systemPrompt +=
                  "\n\n# Project-specific security rules:\n" + securityRules;
              }
            } catch (error) {
              // Best-effort: if reading rules fails, continue without them
              logger.info("Failed to read security rules", error);
            }
          }

          if (
            effectiveApp?.supabaseProjectId &&
            settings.supabase?.accessToken?.value
          ) {
            systemPrompt +=
              "\n\n" +
              SUPABASE_AVAILABLE_SYSTEM_PROMPT +
              "\n\n" +
              (await getSupabaseContext({
                supabaseProjectId: effectiveApp.supabaseProjectId,
              }));
          } else if (
            // Neon projects don't need Supabase.
            !effectiveApp?.neonProjectId &&
            // If in security review mode, we don't need to mention supabase is available.
            !isSecurityReviewIntent
          ) {
            systemPrompt += "\n\n" + SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT;
          }
          const isSummarizeIntent = req.prompt.startsWith(
            "Summarize from chat-id=",
          );
          if (isSummarizeIntent) {
            systemPrompt = SUMMARIZE_CHAT_SYSTEM_PROMPT;
          }

          // Update the system prompt for images if there are image attachments
          const hasImageAttachments =
            req.attachments &&
            req.attachments.some((attachment) =>
              attachment.type.startsWith("image/"),
            );

          const hasUploadedAttachments =
            req.attachments &&
            req.attachments.some(
              (attachment) => attachment.attachmentType === "upload-to-codebase",
            );
          // If there's mixed attachments (e.g. some upload to codebase attachments and some upload images as chat context attachemnts)
          // we will just include the file upload system prompt, otherwise the AI gets confused and doesn't reliably
          // print out the atlarix-write tags.
          // Usually, AI models will want to use the image as reference to generate code (e.g. UI mockups) anyways, so
          // it's not that critical to include the image analysis instructions.
          if (hasUploadedAttachments) {
            systemPrompt += `
  
When files are attached to this conversation, upload them to the codebase using this exact format:

<atlarix-write path="path/to/destination/filename.ext" description="Upload file to codebase">
DYAD_ATTACHMENT_X
</atlarix-write>

Example for file with id of DYAD_ATTACHMENT_0:
<atlarix-write path="src/components/Button.jsx" description="Upload file to codebase">
DYAD_ATTACHMENT_0
</atlarix-write>

  `;
          } else if (hasImageAttachments) {
            systemPrompt += `

# Image Analysis Instructions
This conversation includes one or more image attachments. When the user uploads images:
1. If the user explicitly asks for analysis, description, or information about the image, please analyze the image content.
2. Describe what you see in the image if asked.
3. You can use images as references when the user has coding or design-related questions.
4. For diagrams or wireframes, try to understand the content and structure shown.
5. For screenshots of code or errors, try to identify the issue or explain the code.
`;
          }

          // --- DIAGRAM-FIRST CONTEXT SYSTEM ---
          // Instead of dumping full codebase, we provide:
          // 1. Diagram context (already in systemPrompt via getWorkspaceContext)
          // 2. Instructions to use file exploration tools on demand
          const codebasePrefix = isEngineEnabled
            ? // No codebase prefix if engine is set, we will take of it there.
            []
            : ([
              {
                role: "user",
                content: createDiagramFirstPrompt(),
              },
              {
                role: "assistant",
                content: "Got it! I can see the workspace structure from the diagram. I'll use read_file, search_code, and list_files tools to access specific code when needed.",
              },
            ] as const);

          // If engine is enabled, we will send the other apps codebase info to the engine
          // and process it with smart context.
          const otherCodebasePrefix =
            otherAppsCodebaseInfo && !isEngineEnabled
              ? ([
                {
                  role: "user",
                  content: createOtherAppsCodebasePrompt(otherAppsCodebaseInfo),
                },
                {
                  role: "assistant",
                  content: "OK.",
                },
              ] as const)
              : [];

          // Prune long tool outputs to prevent context bloat (OpenCode style)
          limitedMessageHistory = pruneToolOutputsInMessages(limitedMessageHistory);

          const limitedHistoryChatMessages = limitedMessageHistory.map((msg) => {
            const baseMsg: { role: "user" | "assistant" | "system"; content: string; providerOptions?: object } = {
              role: msg.role as "user" | "assistant" | "system",
              // Why remove thinking tags?
              // Thinking tags are generally not critical for the context
              // and eats up extra tokens.
              content:
                settings.selectedChatMode === "ask"
                  ? removeAtlarixTags(removeNonEssentialTags(msg.content))
                  : removeNonEssentialTags(msg.content),
            };

            // Only include providerOptions if we have actual commit hash values
            // (ephemeral/incognito messages don't have these)
            if (msg.sourceCommitHash || msg.commitHash) {
              baseMsg.providerOptions = {
                "dyad-engine": {
                  ...(msg.sourceCommitHash && { sourceCommitHash: msg.sourceCommitHash }),
                  ...(msg.commitHash && { commitHash: msg.commitHash }),
                },
              };
            }

            return baseMsg;
          });


          let chatMessages: ModelMessage[] = [
            ...codebasePrefix,
            ...otherCodebasePrefix,
            ...limitedHistoryChatMessages,
          ];

          // Check if the last message should include attachments
          if (chatMessages.length >= 2 && attachmentPaths.length > 0) {
            const lastUserIndex = chatMessages.length - 2;
            const lastUserMessage = chatMessages[lastUserIndex];

            if (lastUserMessage.role === "user") {
              // Replace the last message with one that includes attachments
              chatMessages[lastUserIndex] = await prepareMessageWithAttachments(
                lastUserMessage,
                attachmentPaths,
              );
            }
          }

          if (isSummarizeIntent) {
            const previousChat = await db.query.chats.findFirst({
              where: eq(chats.id, parseInt(req.prompt.split("=")[1])),
              with: {
                messages: {
                  orderBy: (messages, { asc }) => [asc(messages.createdAt)],
                },
              },
            });
            chatMessages = [
              {
                role: "user",
                content:
                  "Summarize the following chat: " +
                  formatMessagesForSummary(previousChat?.messages ?? []),
              } satisfies ModelMessage,
            ];
          }
          const simpleStreamText = async ({
            chatMessages,
            modelClient,
            tools,
            systemPromptOverride = systemPrompt,
            dyadDisableFiles = false,
            files,
          }: {
            chatMessages: ModelMessage[];
            modelClient: ModelClient;
            files: CodebaseFile[];
            tools?: ToolSet;
            systemPromptOverride?: string;
            dyadDisableFiles?: boolean;
          }) => {
            if (isEngineEnabled) {
              logger.log(
                "sending AI request to engine with request id:",
                dyadRequestId,
              );
            } else {
              logger.log("sending AI request");
            }
            let versionedFiles: VersionedFiles | undefined;
            if (isDeepContextEnabled) {
              versionedFiles = await getVersionedFiles({
                files,
                chatMessages,
                appPath,
              });
            }
            const smartContextMode: SmartContextMode = isDeepContextEnabled
              ? "deep"
              : "balanced";
            // Build provider options with correct Google/Vertex thinking config gating
            const providerOptions: Record<string, any> = {
              "dyad-engine": {
                dyadAppId: effectiveAppId ?? updatedChat.app?.id,
                dyadRequestId,
                dyadDisableFiles,
                dyadSmartContextMode: smartContextMode,
                dyadFiles: versionedFiles ? undefined : files,
                dyadVersionedFiles: versionedFiles,
                dyadMentionedApps: mentionedAppsCodebases.map(
                  ({ files, appName }) => ({
                    appName,
                    files,
                  }),
                ),
              },
              "dyad-gateway": getExtraProviderOptions(
                modelClient.builtinProviderId,
                settings,
              ),
              openai: {
                reasoningSummary: "auto",
              } satisfies OpenAIResponsesProviderOptions,
            };

            // Conditionally include Google thinking config only for supported models
            const optionsModel = getEffectiveModelForOptions(settings);
            const selectedModelName = optionsModel.name || "";
            const providerId = modelClient.builtinProviderId;
            const isVertex = providerId === "vertex";
            const isGoogle = providerId === "google";
            const isAnthropic = providerId === "anthropic";
            const isPartnerModel = selectedModelName.includes("/");
            const isGeminiModel = selectedModelName.startsWith("gemini");
            const isFlashLite = selectedModelName.includes("flash-lite");

            // Keep Google provider behavior unchanged: always include includeThoughts
            if (isGoogle) {
              providerOptions.google = {
                thinkingConfig: {
                  includeThoughts: true,
                },
              } satisfies GoogleGenerativeAIProviderOptions;
            }

            // Vertex-specific fix: only enable thinking on supported Gemini models
            if (isVertex && isGeminiModel && !isFlashLite && !isPartnerModel) {
              providerOptions.google = {
                thinkingConfig: {
                  includeThoughts: true,
                },
              } satisfies GoogleGenerativeAIProviderOptions;
            }

            const streamResult = streamText({
              headers: isAnthropic
                ? {
                  "anthropic-beta": "context-1m-2025-08-07",
                }
                : undefined,
              maxOutputTokens: await getMaxTokens(optionsModel),
              temperature: await getTemperature(optionsModel),
              maxRetries: 2,
              model: modelClient.model,
              stopWhen: [stepCountIs(20), hasToolCall("edit-code")],
              providerOptions,
              system: systemPromptOverride,
              tools,
              messages: chatMessages.filter((m) => m.content),
              onFinish: (response) => {
                const totalTokens = response.usage?.totalTokens;

                if (typeof totalTokens === "number") {
                  // We use the highest total tokens used (we are *not* accumulating)
                  // since we're trying to figure it out if we're near the context limit.
                  maxTokensUsed = Math.max(maxTokensUsed ?? 0, totalTokens);

                  // Persist the aggregated token usage on the placeholder assistant message
                  // Only for non-ephemeral chats
                  if (!isEphemeralWorkspace) {
                    void db
                      .update(messages)
                      .set({ maxTokensUsed: maxTokensUsed })
                      .where(eq(messages.id, placeholderAssistantMessage.id))
                      .catch((error) => {
                        logger.error(
                          "Failed to save total tokens for assistant message",
                          error,
                        );
                      });
                  }

                  logger.log(
                    `Total tokens used (aggregated for message ${placeholderAssistantMessage.id}): ${maxTokensUsed}`,
                  );

                  // Post-turn compaction (OpenCode style): compact proactively so next user message is instant
                  if (!isEphemeralWorkspace && req.chatId > 0) {
                    schedulePostTurnCompaction({
                      chatId: req.chatId,
                      totalTokensUsed: maxTokensUsed,
                      providerId: modelClient.builtinProviderId ?? optionsModel?.provider,
                    });
                  }
                } else {
                  logger.log("Total tokens used: unknown");
                }
              },
              onError: (error: any) => {
                const modelNotFoundUserMessage = "The selected model was not found for any provider. Please choose a different model in Settings.";
                let errorMessage = (error as any)?.error?.message;
                const responseBody = error?.error?.responseBody;
                if (errorMessage && responseBody) {
                  errorMessage += "\n\nDetails: " + responseBody;
                }
                let message = errorMessage || JSON.stringify(error);
                if (isDiagramModelNotFoundError(error)) {
                  message = modelNotFoundUserMessage;
                }
                const requestIdPrefix = isEngineEnabled
                  ? `[Request ID: ${dyadRequestId}] `
                  : "";
                logger.error(
                  `AI stream text error for request: ${requestIdPrefix} errorMessage=${errorMessage} error=`,
                  error,
                );
                event.sender.send("chat:response:error", {
                  chatId: req.chatId,
                  error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${requestIdPrefix}${message}`,
                });
                // Clean up the abort controller
                activeStreams.delete(req.chatId);
              },
              abortSignal: abortController.signal,
            });
            return {
              fullStream: streamResult.fullStream,
              usage: streamResult.usage,
            };
          };

          let lastDbSaveAt = 0;

          const processResponseChunkUpdate = async ({
            fullResponse,
          }: {
            fullResponse: string;
          }) => {
            if (
              fullResponse.includes("$$SUPABASE_CLIENT_CODE$$") &&
              effectiveApp?.supabaseProjectId
            ) {
              const supabaseClientCode = await getSupabaseClientCode({
                projectId: effectiveApp.supabaseProjectId,
              });
              fullResponse = fullResponse.replace(
                "$$SUPABASE_CLIENT_CODE$$",
                supabaseClientCode,
              );
            }
            // Store the current partial response
            partialResponses.set(req.chatId, fullResponse);
            // Save to DB (in case user is switching chats during the stream)
            // Only for non-ephemeral chats
            const now = Date.now();
            if (now - lastDbSaveAt >= 150 && !isEphemeralWorkspace) {
              await db
                .update(messages)
                .set({ content: fullResponse })
                .where(eq(messages.id, placeholderAssistantMessage.id));

              lastDbSaveAt = now;
            }

            // Update the placeholder assistant message content in the messages array
            const currentMessages = [...updatedChat.messages];
            if (
              currentMessages.length > 0 &&
              currentMessages[currentMessages.length - 1].role === "assistant"
            ) {
              currentMessages[currentMessages.length - 1].content = fullResponse;
            }

            // Update the assistant message in the database
            safeSend(event.sender, "chat:response:chunk", {
              chatId: req.chatId,
              messages: currentMessages,
            });
            return fullResponse;
          };

          if (settings.selectedChatMode === "agent") {
            // Workspace-aware tool filtering (uses effective workspace from outer scope)
            const workspaceFilteredTools = ToolRegistry.toAISDKFormatForContext(hasWorkspace);

            // Convert to tool set format expected by AI SDK
            const tools: ToolSet = {};
            for (const tool of workspaceFilteredTools) {
              tools[tool.function.name] = {
                description: tool.function.description,
                parameters: tool.function.parameters,
                execute: async (args: any) => {
                  // Execute tool via registry
                  const result = await ToolRegistry.execute(tool.function.name, args);
                  return JSON.stringify(result);
                },
              };
            }

            // Add generate-code meta-tool
            tools["generate-code"] = {
              description:
                "ALWAYS use this tool whenever generating or editing code for the codebase.",
              inputSchema: z.object({}),
              execute: async () => "",
            };

            // Merge global + workspace MCP tools for Agent mode
            const agentMcpTools = await getMcpTools(event, effectiveAppId ?? null);
            Object.assign(tools, agentMcpTools);

            const { fullStream } = await simpleStreamText({
              chatMessages: limitedHistoryChatMessages,
              modelClient,
              tools,
              systemPromptOverride: constructSystemPrompt({
                aiRules: await readAiRules(appPath),
                chatMode: "build",
                contextSize: Math.min(await getContextWindow(), 128_000),
                enableTurboEditsV2: false,
              }),
              files: files,
              dyadDisableFiles: true,
            });

            const result = await processStreamChunks({
              fullStream,
              fullResponse,
              abortController,
              chatId: req.chatId,
              processResponseChunkUpdate,
            });
            fullResponse = result.fullResponse;
            chatMessages.push({
              role: "assistant",
              content: fullResponse,
            });
            chatMessages.push({
              role: "user",
              content: "OK.",
            });
          }

          // v3.9: Set in Build block; used when updating assistant message after stream
          let preExchangeSnapshotId: number | null = null;
          let filesWrittenInThisExchange: string[] = [];

          // Ask mode with workspace: use read-only tools for exploration
          if (settings.selectedChatMode === "ask" && effectiveApp) {
            logger.log("Ask mode with workspace - enabling read-only tools");

            const askModeTools = ToolRegistry.getToolsForAskMode();
            const askLoader = getOrCreateToolSessionLoader(req.chatId);
            const askLoadedNames = askLoader.getLoadedToolNames();
            const askToolsToInclude = askModeTools.filter(
              (t) => askLoadedNames.has(t.name) || isCoreTool(t)
            );
            const askManifest = generateManifest(askModeTools, true);

            const askTools: ToolSet = {};
            for (const tool of askToolsToInclude) {
              askTools[tool.name] = {
                description: tool.description,
                parameters: tool.parameters,
                execute: async (args: any) => {
                  askLoader.onToolCall(tool.name);
                  try {
                    const execArgs: any = {
                      ...args,
                      workspace: appPath,
                      workspaceId: effectiveAppId!,
                    };
                    if (tool.name === "stream_terminal_output" || tool.name === "stream_pipeline_logs") {
                      execArgs.chatId = req.chatId;
                      execArgs._sendToolActivity = (label: string) => {
                        safeSend(event.sender, "chat:tool:start", {
                          chatId: req.chatId,
                          toolName: label,
                        });
                        return () => {
                          safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                        };
                      };
                    }
                    const execResult = await ToolRegistry.execute(tool.name, execArgs);

                    // Return formatted result for display
                    return JSON.stringify(execResult);
                  } catch (error) {
                    return JSON.stringify({ success: false, error: String(error) });
                  }
                },
              };
            }

            // request_mode_change: Ask -> Build requires user approval
            const requestModeChangeTool = ToolRegistry.get("request_mode_change");
            if (requestModeChangeTool) {
              askTools["request_mode_change"] = {
                description: requestModeChangeTool.description,
                parameters: requestModeChangeTool.parameters,
                execute: async (args: any) => {
                  const result = await ToolRegistry.execute("request_mode_change", {
                    ...args,
                    hasWorkspace: true,
                    currentMode: "ask",
                    intentMode: settings.intentMode ?? "ask",
                    hasPendingPermissions: false,
                    chatId: req.chatId,
                  });
                  if (result && typeof result === "object" && result.__mode_change_requested) {
                    safeSend(event.sender, "mode_change_requested", {
                      chatId: req.chatId,
                      requestedMode: result.requestedMode,
                      reason: result.reason ?? "",
                    });
                    const approved = await waitForModeChangeResponse(req.chatId);
                    if (approved) {
                      return JSON.stringify({
                        success: true,
                        message: "Mode switched to Build. You may now use write/run tools.",
                      });
                    }
                    return JSON.stringify({
                      success: false,
                      message: "User declined. Remain in Ask mode and explain without making changes.",
                    });
                  }
                  return JSON.stringify(result?.success === false ? result : { success: true, ...result });
                },
              };
            }

            // Merge global + workspace MCP tools so workspace chats can use MCP (e.g. GitHub)
            const askMcpTools = await getMcpTools(event, effectiveAppId!);
            Object.assign(askTools, askMcpTools);
            logger.log(`Ask mode: ${Object.keys(askTools).length} read-only tools available (incl. MCP)`);

            const askModePrompt = `
IMPORTANT: You are in ASK mode - a read-only assistant for exploring this codebase.

Available tools (read-only):
- read_file: Read file contents
- list_files: List directory contents  
- search_code: Search for patterns in code
- find_file: Find files by name pattern
- web_search, deep_search, read_url: Research and web content
- get_diagram: Generate architecture diagrams
- git_status, git_diff: View git information
- recall_memory, search_memory: Access saved learnings
- parse_code_structure, get_change_impact, diagnose_issue, health_check: Code analysis
- ask_user: Ask for clarification
- request_mode_change: If the user wants implementation or code changes, call this with mode "build" and a short reason; wait for user approval before making changes.

NOT available in Ask mode (Build mode only):
- write_file, delete_file, rename_file: File modifications
- run_command, run_tests: Command execution
- save_learning: Memory modifications

If the user requests modifications, use request_mode_change to request Build mode with a reason and wait for approval. Do NOT make changes until the user approves.`;

            const { fullStream: askStream } = await simpleStreamText({
              chatMessages,
              modelClient,
              tools: askTools,
              systemPromptOverride:
                constructSystemPrompt({
                  aiRules: await readAiRules(appPath),
                  chatMode: "ask",
                  contextSize: Math.min(await getContextWindow(), 128_000),
                  enableTurboEditsV2: false,
                }) +
                askModePrompt +
                "\n\n" +
                askManifest,
              files: files,
            });

            // Process the stream
            const askResult = await processStreamChunks({
              fullStream: askStream,
              fullResponse,
              abortController,
              chatId: req.chatId,
              processResponseChunkUpdate,
            });
            fullResponse = askResult.fullResponse;
          } else {
            // BUILD MODE - Native tool calling (like Agent mode)
            // AI has access to all workspace tools via function calling
            // Permission interceptor buffers write operations for user approval
            logger.log("Build mode with native tool calling + permission system");

            // v3.9: Snapshot synchronously at exchange start (before any tool runs) for conversation revert
            if (effectiveAppId != null && appPath) {
              try {
                const snap = await createSnapshot(
                  effectiveAppId,
                  "pre-exchange",
                  appPath,
                  effectiveAppId,
                  updatedChat.messages.map((m: any) => ({ role: m.role, content: m.content ?? "" }))
                );
                preExchangeSnapshotId = snap.id;
                logger.log(`[Build Mode] Created pre-exchange snapshot: ${preExchangeSnapshotId}`);
              } catch (snapErr) {
                logger.warn("Failed to create pre-exchange snapshot:", snapErr);
              }
            }

            const workspacePath = appPath;
            let workspaceOverride: { path: string; id: number } | null = null;
            const buildModeToolsMetadata = ToolRegistry.getToolsForContext(hasWorkspace);
            const buildLoader = getOrCreateToolSessionLoader(req.chatId);
            const buildLoadedNames = buildLoader.getLoadedToolNames();
            const buildToolsToInclude = buildModeToolsMetadata.filter(
              (t) => buildLoadedNames.has(t.name) || isCoreTool(t)
            );
            const buildManifest = generateManifest(buildModeToolsMetadata, false);
            const buildSystemPromptWithManifest = systemPrompt + "\n\n" + buildManifest;

            // Create permission interceptor for this session
            const permissionInterceptor = new PermissionInterceptor(
              workspacePath,
              effectiveAppId ?? undefined,
            );

            // Register interceptor for IPC handlers (so UI can approve/reject)
            registerInterceptor(req.chatId, permissionInterceptor);

            // Listen for terminal output events and forward to frontend; v3.9: also feed to StreamManager for stream_terminal_output
            permissionInterceptor.on('terminal-output', (payload: any) => {
              feedTerminalOutput(req.chatId, payload.output ?? "");
              safeSend(event.sender, "terminal-output", {
                chatId: req.chatId,
                commandId: payload.operationId,
                command: payload.command,
                output: payload.output,
                status: payload.status,
                exitCode: payload.exitCode,
                isPermissionBased: true, // Don't force-switch to terminal tab
              });
              logger.log(`[Build Mode] Terminal output sent: ${payload.command} (${payload.status})`);
            });

            const tools: ToolSet = {};
            for (const toolMeta of buildToolsToInclude) {
              const toolName = toolMeta.name;
              tools[toolName] = {
                description: toolMeta.description,
                parameters: toolMeta.parameters,
                execute: async (args: any) => {
                  buildLoader.onToolCall(toolName);
                  const toolActivityId = `tool-${toolName}-${Date.now()}`;
                  let activityStatus: "done" | "error" = "done";
                  safeSend(event.sender, "chat:activity", {
                    id: toolActivityId,
                    type: "tool_use",
                    label: toolName,
                    status: "running",
                    timestamp: Date.now(),
                  });
                  try {
                    const effectivePath = workspaceOverride?.path ?? workspacePath ?? "";
                    const effectiveId = workspaceOverride?.id ?? effectiveAppId ?? undefined;
                    const isStreamTool =
                      toolName === "stream_terminal_output" ||
                      toolName === "stream_pipeline_logs";
                    const executeArgs: any = {
                      ...args,
                      workspace: effectivePath || undefined,
                      workspaceId: effectiveId,
                      chatMode: "build",
                    };
                    if (isStreamTool) {
                      executeArgs.chatId = req.chatId;
                      executeArgs._sendToolActivity = (label: string) => {
                        safeSend(event.sender, "chat:tool:start", {
                          chatId: req.chatId,
                          toolName: label,
                        });
                        return () => {
                          safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });
                        };
                      };
                    }
                    const result = await ToolRegistry.execute(toolName, executeArgs);

                    if (
                      toolName === "create_workspace" &&
                      result &&
                      typeof result === "object" &&
                      !permissionInterceptor.isPermissionRequest(result) &&
                      (result as any).workspace_path != null &&
                      (result as any).workspace_id != null
                    ) {
                      const r = result as { workspace_path: string; workspace_id: number };
                      workspaceOverride = { path: r.workspace_path, id: r.workspace_id };
                      permissionInterceptor.setWorkspace(r.workspace_path, r.workspace_id);
                      logger.log(
                        `[Build Mode] Switched to new workspace for this turn: ${r.workspace_path} (id: ${r.workspace_id})`,
                      );
                    }

                    // Check if this is a permission request (object or string)
                  if (permissionInterceptor.isPermissionRequest(result)) {
                    const permRequest = permissionInterceptor.parsePermissionRequest(result);
                    if (permRequest) {
                      const operationId = permissionInterceptor.generateOperationId();
                      permissionInterceptor.bufferOperation(operationId, permRequest);

                      // Send permission request to frontend for display
                      safeSend(event.sender, "permission-request", {
                        chatId: req.chatId,
                        operationId,
                        request: permRequest,
                      });

                      logger.log(`[Build Mode] Permission request buffered: ${operationId}`);

                      try {
                        // BLOCKING: Wait for user to approve or reject
                        const approved = await permissionInterceptor.waitForApproval(operationId);

                        if (approved) {
                          // User approved - return success to AI
                          const execResult = permissionInterceptor.getExecutionResult(operationId);
                          logger.log(`[Build Mode] Permission approved: ${operationId}`);

                          // v3.9: Record written paths for this exchange (revert UI)
                          const preview = permRequest.preview as { path?: string; paths?: string[] };
                          if (permRequest.operation === "write_multiple_files" && preview.paths?.length) {
                            filesWrittenInThisExchange.push(...preview.paths);
                          } else if (preview.path) {
                            filesWrittenInThisExchange.push(preview.path);
                          }

                          // Check if output contains error patterns (dev server may start but have compilation errors)
                          const output = execResult.output || '';
                          const hasCompilationErrors = /error:|Error:|ERROR:|failed to|Failed to|Cannot find|cannot find|is not defined|is not a function|SyntaxError|TypeError|ReferenceError/i.test(output);

                          if (hasCompilationErrors) {
                            // Command ran but has errors in output - tell AI there are issues
                            logger.log(`[Build Mode] Command output contains errors: ${operationId}`);
                            return JSON.stringify({
                              success: true, // Command started
                              hasErrors: true, // But has compilation/runtime errors
                              warning: "The command ran but the output shows errors. Please review the output and fix the underlying code issue before running the same command again.",
                              message: `Command started but output shows errors`,
                              path: execResult.path,
                              output: output.slice(-2000), // Last 2000 chars for context
                            });
                          }

                          return JSON.stringify({
                            success: true,
                            message: `Successfully ${permRequest.operation === "write_file" ? "wrote" : "executed"} ${(permRequest.preview as any).path || "operation"}`,
                            path: execResult.path,
                            output: execResult.output,
                          });
                        } else {
                          // Check if this was a command failure vs user rejection
                          const execResult = permissionInterceptor.getExecutionResult(operationId);

                          if (execResult.exitCode !== undefined) {
                            // Command was executed but failed - include error details for AI
                            logger.log(`[Build Mode] Command failed: ${operationId} (exit ${execResult.exitCode})`);
                            return JSON.stringify({
                              success: false,
                              error: execResult.error || `Command failed with exit code ${execResult.exitCode}`,
                              exitCode: execResult.exitCode,
                              output: execResult.output,  // Include terminal output for AI context
                              operation: permRequest.operation,
                              path: (permRequest.preview as any).path || (permRequest.preview as any).command,
                            });
                          } else {
                            // User actually rejected or timeout
                            logger.log(`[Build Mode] Permission denied: ${operationId}`);
                            return JSON.stringify({
                              success: false,
                              error: "Permission denied by user",
                              operation: permRequest.operation,
                              path: (permRequest.preview as any).path,
                            });
                          }
                        }
                      } catch (error) {
                        logger.error(`[Build Mode] Permission error: ${operationId}`, error);
                        return JSON.stringify({
                          success: false,
                          error: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
                          timedOut: true,
                        });
                      }
                    }
                  }

                    // Not a permission request - return result directly
                    return typeof result === 'string' ? result : JSON.stringify(result);
                  } catch (err) {
                    activityStatus = "error";
                    throw err;
                  } finally {
                    safeSend(event.sender, "chat:activity", {
                      id: toolActivityId,
                      type: "tool_use",
                      label: toolName,
                      status: activityStatus,
                      timestamp: Date.now(),
                    });
                  }
                },
              };
            }

            // Merge global + workspace MCP tools so workspace Build chats can use MCP (e.g. GitHub)
            const buildMcpTools = await getMcpTools(event, effectiveAppId ?? null);
            Object.assign(tools, buildMcpTools);

            // v2.1: Add delegate_to_agent when in Guided or Autonomous mode
            const agentMode = settings.agentMode ?? "guided";
            if (agentMode === "guided" || agentMode === "autonomous") {
              const delegateTool = ToolRegistry.get("delegate_to_agent");
              if (delegateTool) {
                tools["delegate_to_agent"] = {
                  description: delegateTool.description,
                  parameters: delegateTool.parameters,
                  execute: async (args: any) => {
                    const id = `delegation-${Date.now()}-${args.agent_id ?? "agent"}`;
                    const agentId = String(args.agent_id ?? "agent");
                    const task = String(args.task ?? "");
                    const startTime = Date.now();
                    safeSend(event.sender, "chat:activity", {
                      type: "delegation_start",
                      id,
                      parentId: undefined,
                      depth: 0,
                      agent: agentId,
                      task,
                      status: "active",
                      timestamp: startTime,
                      label: `Delegation to ${agentId.replace(/^./, (c) => c.toUpperCase())}`,
                    });
                    const result = await ToolRegistry.execute("delegate_to_agent", {
                      ...args,
                      workspace: workspacePath || undefined,
                      workspaceId: effectiveAppId ?? undefined,
                      chatMode: "build",
                      depth: 0,
                    });
                    const duration = Date.now() - startTime;
                    const isError = result?.success === false;
                    safeSend(event.sender, "chat:activity", {
                      type: isError ? "delegation_error" : "delegation_complete",
                      id,
                      status: isError ? "error" : "done",
                      result: typeof result === "object" && result ? (result as any).summary : undefined,
                      duration,
                      timestamp: Date.now(),
                      label: `Delegation to ${agentId.replace(/^./, (c) => c.toUpperCase())}`,
                      detail: typeof result === "object" && (result as any).summary ? String((result as any).summary).slice(0, 200) : undefined,
                    });
                    return typeof result === "string" ? result : JSON.stringify(result);
                  },
                };
              }
            }

            // request_mode_change: Build path (switch to Ask or emit activity for Auto)
            const requestModeChangeToolBuild = ToolRegistry.get("request_mode_change");
            if (requestModeChangeToolBuild) {
              tools["request_mode_change"] = {
                description: requestModeChangeToolBuild.description,
                parameters: requestModeChangeToolBuild.parameters,
                execute: async (args: any) => {
                  const hasPending =
                    permissionInterceptor.getAllOperationsCount() >
                    permissionInterceptor.getExecutedOperationsCount();
                  const result = await ToolRegistry.execute("request_mode_change", {
                    ...args,
                    hasWorkspace,
                    currentMode: "build",
                    intentMode: settings.intentMode ?? "build",
                    hasPendingPermissions: hasPending,
                    chatId: req.chatId,
                  });
                  if (
                    result &&
                    typeof result === "object" &&
                    (result as any).__emit_mode_change_activity
                  ) {
                    safeSend(event.sender, "chat:activity", {
                      id: `mode-change-${Date.now()}`,
                      type: "mode_change",
                      label: `Switched to ${(result as any).requestedMode === "build" ? "Build" : "Ask"} (Auto)`,
                      status: "done",
                      timestamp: Date.now(),
                      detail: (result as any).reason,
                    });
                  }
                  return typeof result === "string" ? result : JSON.stringify(result);
                },
              };
            }

            logger.log(`Build mode: ${Object.keys(tools).length} tools available`);

            // ═══════════════════════════════════════════════════════════════
            // SMART AGENTIC TOOL LOOP
            // - Dynamic iteration limit (can be extended by user)
            // - Time limit safety (10 min max)
            // - Completion detection (AI signals when done)
            // - Progress emission to frontend
            // ═══════════════════════════════════════════════════════════════
            let maxIterations = DEFAULT_AGENTIC_CONFIG.maxIterations;
            const loopStartTime = Date.now();
            let hasShownWarning = false;
            let agenticIteration = 0;
            let agenticMessages = [...chatMessages]; // Copy current messages
            let allToolResults: { tool: string; result: string }[] = [];
            let totalToolExecutions = 0; // Track total tools executed across all iterations

            const { containsTextToolCall, parseTextToolCalls, stripToolCallXML } = await import("../utils/text_tool_parser");

            try {
              while (agenticIteration < maxIterations) {
                // Time limit safety check
                if (Date.now() - loopStartTime > DEFAULT_AGENTIC_CONFIG.maxDurationMs) {
                  logger.warn(`[Agentic Loop] Hit time limit (10 minutes)`);
                  safeSend(event.sender, "chat:iteration:timeout", {
                    chatId: req.chatId,
                    message: "Task took too long. Stopping to prevent runaway costs.",
                    duration: Date.now() - loopStartTime,
                  });
                  break;
                }

                // Emit progress to frontend
                safeSend(event.sender, "chat:iteration:progress", {
                  chatId: req.chatId,
                  iteration: agenticIteration + 1,
                  maxIterations,
                  totalToolsExecuted: totalToolExecutions,
                });

                logger.log(`[Agentic Loop] Iteration ${agenticIteration + 1}/${maxIterations}`);

                const { fullStream } = await simpleStreamText({
                  chatMessages: agenticMessages,
                  modelClient,
                  tools,
                  systemPromptOverride: buildSystemPromptWithManifest,
                  files: files,
                });

                // Process the stream
                const result = await processStreamChunks({
                  fullStream,
                  fullResponse,
                  abortController,
                  chatId: req.chatId,
                  processResponseChunkUpdate,
                });
                fullResponse = result.fullResponse;

                // ═══════════════════════════════════════════════════════════
                // OPTION A: Track tool execution (works with ALL providers)
                // ═══════════════════════════════════════════════════════════

                // Check for text-based tool calls (MiniMax, Claude XML, etc.)
                const hasTextToolCalls = containsTextToolCall(fullResponse);

                // Check how many operations were buffered in this iteration
                // (This tracks native function calling - Claude, GPT via OpenRouter)
                const currentOpCount = permissionInterceptor.getAllOperationsCount();
                const executedOpCount = permissionInterceptor.getExecutedOperationsCount();
                logger.log(`[Agentic Loop] Operation counts: total=${currentOpCount}, executed=${executedOpCount}, tracked=${totalToolExecutions}`);

                const hadNativeToolExecution = currentOpCount > totalToolExecutions;

                if (hasTextToolCalls) {
                  logger.log("[Agentic Loop] Detected text-based tool calls, parsing and executing...");
                } else if (hadNativeToolExecution) {
                  const newOps = currentOpCount - totalToolExecutions;
                  logger.log(`[Agentic Loop] Native tool calls detected (${newOps} new operations, ${currentOpCount} total)`);
                  totalToolExecutions = currentOpCount;
                }

                // Check if task is explicitly complete
                if (DEFAULT_AGENTIC_CONFIG.requireExplicitCompletion && isTaskComplete(fullResponse)) {
                  logger.info(`[Agentic Loop] Task completed at iteration ${agenticIteration + 1}`);
                  break;
                }

                // If no tool calls of any kind, end the loop
                if (!hasTextToolCalls && !hadNativeToolExecution) {
                  logger.log("[Agentic Loop] No tool calls detected (text-based or native), ending loop");
                  logger.log(`[Agentic Loop] Total tools executed: ${totalToolExecutions}`);
                  break;
                }

                // Parse and execute text-based tool calls
                const textToolCalls = hasTextToolCalls ? parseTextToolCalls(fullResponse) : [];

                if (hasTextToolCalls && textToolCalls.length === 0) {
                  logger.log("[Agentic Loop] No parseable tool calls found, ending loop");
                  break;
                }

                // Execute text-based tools. When all are read-only, run in parallel (Phase 5).
                const iterationResults: { tool: string; result: string }[] = [];
                let hasPermissionRequest = hadNativeToolExecution; // Carry forward native tool detection

                const readOnlyNames = new Set(
                  ToolRegistry.getAll().filter((t) => t.isReadOnly).map((t) => t.name)
                );
                const allReadOnly =
                  textToolCalls.length > 1 &&
                  textToolCalls.every((tc) => readOnlyNames.has(tc.toolName));

                if (allReadOnly) {
                  for (const tc of textToolCalls) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolName: tc.toolName,
                    });
                  }
                }
                const toolCallsToProcess = allReadOnly
                  ? await Promise.all(
                      textToolCalls.map(async (tc) => {
                        const argsWithWorkspace = {
                          ...tc.args,
                          workspace: workspacePath || undefined,
                          workspaceId: effectiveAppId ?? undefined,
                          chatMode: "build",
                        };
                        try {
                          const r = await ToolRegistry.execute(tc.toolName, argsWithWorkspace);
                          return { toolCall: tc, toolResult: r };
                        } catch (e) {
                          return {
                            toolCall: tc,
                            toolResult: `Error: ${e instanceof Error ? e.message : String(e)}`,
                          };
                        }
                      })
                    )
                  : null;

                if (allReadOnly) {
                  logger.log(`[Agentic Loop] Executed ${textToolCalls.length} read-only tools in parallel`);
                }

                for (let i = 0; i < textToolCalls.length; i++) {
                  const toolCall = textToolCalls[i];
                  if (!toolCallsToProcess) {
                    safeSend(event.sender, "chat:tool:start", {
                      chatId: req.chatId,
                      toolName: toolCall.toolName,
                    });
                  }
                  let toolResult: unknown;

                  if (toolCallsToProcess) {
                    toolResult = toolCallsToProcess[i].toolResult;
                  } else {
                    try {
                      if (!tools[toolCall.toolName]) {
                        toolResult = `Error: Unknown tool "${toolCall.toolName}"`;
                      } else {
                        const argsWithWorkspace = {
                          ...toolCall.args,
                          workspace: workspacePath || undefined,
                          workspaceId: effectiveAppId ?? undefined,
                          chatMode: "build",
                        };
                        toolResult = await ToolRegistry.execute(toolCall.toolName, argsWithWorkspace);
                      }
                    } catch (toolError) {
                      toolResult = `Error: ${toolError instanceof Error ? toolError.message : String(toolError)}`;
                    }
                  }
                  safeSend(event.sender, "chat:tool:end", { chatId: req.chatId });

                  try {
                    if (typeof toolResult === "string" && toolResult.startsWith("Error:")) {
                      iterationResults.push({ tool: toolCall.toolName, result: toolResult });
                      continue;
                    }

                    // Check if this is a permission request
                    if (permissionInterceptor.isPermissionRequest(toolResult)) {
                      const permRequest = permissionInterceptor.parsePermissionRequest(toolResult);
                      if (permRequest) {
                        const operationId = permissionInterceptor.generateOperationId();
                        permissionInterceptor.bufferOperation(operationId, permRequest);
                        safeSend(event.sender, "permission-request", {
                          chatId: req.chatId,
                          operationId,
                          request: permRequest,
                        });
                        logger.log(`[Agentic Loop] Permission request buffered: ${operationId}`);
                        hasPermissionRequest = true;
                        try {
                          const approved = await permissionInterceptor.waitForApproval(operationId);
                          if (approved) {
                            const execResult = permissionInterceptor.getExecutionResult(operationId);
                            iterationResults.push({
                              tool: toolCall.toolName,
                              result: JSON.stringify({
                                success: true,
                                message: `Operation completed`,
                                path: execResult.path,
                                output: execResult.output,
                              }),
                            });
                          } else {
                            const execResult = permissionInterceptor.getExecutionResult(operationId);
                            if (execResult.exitCode !== undefined) {
                              iterationResults.push({
                                tool: toolCall.toolName,
                                result: JSON.stringify({
                                  success: false,
                                  error: execResult.error || `Command failed with exit code ${execResult.exitCode}`,
                                  exitCode: execResult.exitCode,
                                  output: execResult.output,
                                }),
                              });
                            } else {
                              iterationResults.push({
                                tool: toolCall.toolName,
                                result: JSON.stringify({ success: false, error: "Permission denied by user" }),
                              });
                            }
                          }
                        } catch (error) {
                          iterationResults.push({
                            tool: toolCall.toolName,
                            result: JSON.stringify({
                              success: false,
                              error: `Permission timeout: ${error instanceof Error ? error.message : String(error)}`,
                            }),
                          });
                        }
                      }
                    } else {
                      const resultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
                      iterationResults.push({ tool: toolCall.toolName, result: resultStr });
                      logger.log(`[Agentic Loop] Tool executed: ${toolCall.toolName} ✓`);
                    }
                  } catch (toolError) {
                    logger.error(`[Agentic Loop] Tool error: ${toolCall.toolName}`, toolError);
                    iterationResults.push({
                      tool: toolCall.toolName,
                      result: `Error: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
                    });
                  }
                }

                // Store all tool results
                allToolResults.push(...iterationResults);
                totalToolExecutions += iterationResults.length; // Track total executions

                // Format tool results to feed back to AI
                const toolResultsMessage = iterationResults.map(r =>
                  `<tool_result tool="${r.tool}">\n${r.result}\n</tool_result>`
                ).join('\n\n');

                // Add assistant's response (with tool calls) to message history
                agenticMessages.push({
                  role: 'assistant' as const,
                  content: fullResponse,
                });

                // Add tool results as a user message so AI can continue
                agenticMessages.push({
                  role: 'user' as const,
                  content: `Here are the results of the tools you called:\n\n${toolResultsMessage}\n\nPlease continue with your task based on these results.`,
                });

                // Keep fullResponse for UI continuity - don't reset
                // (Conversation history already has the response)
                agenticIteration++;

                // If we hit permission requests, the AI should continue after approval
                if (hasPermissionRequest) {
                  logger.log("[Agentic Loop] Had permission requests, continuing loop...");
                }

                // 75% warning: Ask user if they want to continue
                const warningThreshold = Math.floor(maxIterations * 0.75);
                if (agenticIteration === warningThreshold && !hasShownWarning) {
                  hasShownWarning = true;

                  safeSend(event.sender, "chat:iteration:warning", {
                    chatId: req.chatId,
                    iteration: agenticIteration,
                    maxIterations,
                    totalToolsExecuted: totalToolExecutions,
                    estimatedTokens: totalToolExecutions * 500,
                    message: `Task running long (${agenticIteration}/${maxIterations}). Continue?`,
                  });

                  const approval = await waitForUserContinuation(req.chatId, 30000, true);
                  if (approval) {
                    maxIterations += 10;
                    logger.info(`[Agentic Loop] Extended to ${maxIterations} iterations`);
                  } else {
                    logger.info(`[Agentic Loop] User declined continuation`);
                    break;
                  }
                }
              }

              if (agenticIteration >= maxIterations) {
                logger.warn(`[Agentic Loop] Hit max iterations (${maxIterations})`);
                safeSend(event.sender, "chat:iteration:limit-reached", {
                  chatId: req.chatId,
                  message: "Hit iteration limit. Task may be incomplete.",
                  iterations: agenticIteration,
                  totalToolsExecuted: totalToolExecutions,
                });
              }

              // Structured metrics logging
              logger.info(`[Agentic Loop] Completed:`, {
                chatId: req.chatId,
                iterations: agenticIteration,
                toolsExecuted: totalToolExecutions,
                durationMs: Date.now() - loopStartTime,
                completedNaturally: isTaskComplete(fullResponse),
                hitIterationLimit: agenticIteration >= maxIterations,
                userExtensions: Math.floor((maxIterations - DEFAULT_AGENTIC_CONFIG.maxIterations) / 10),
              });
              hadToolCallsOrPermissions =
                totalToolExecutions > 0 || permissionInterceptor.getAllOperationsCount() > 0;
              // ═══════════════════════════════════════════════════════════════

            } catch (streamError) {
              // Check if this was an abort error
              if (abortController.signal.aborted) {
                const chatId = req.chatId;
                const partialResponse = partialResponses.get(req.chatId);
                // If we have a partial response, save it to the database
                if (partialResponse) {
                  try {
                    const cancelledContent = `${partialResponse}

[Response cancelled by user]`;
                    if (!isEphemeralWorkspace) {
                      await db
                        .update(messages)
                        .set({
                          content: cancelledContent,
                        })
                        .where(eq(messages.id, placeholderAssistantMessage.id));

                      logger.log(
                        `Updated cancelled response for placeholder message ${placeholderAssistantMessage.id} in chat ${chatId}`,
                      );
                    } else {
                      const { addEphemeralMessage } = await import("./chat_only_handlers");
                      addEphemeralMessage(req.chatId, { role: "assistant", content: cancelledContent });
                      logger.log(`Persisted partial response to ephemeral chat ${chatId} after abort`);
                    }
                    partialResponses.delete(req.chatId);
                  } catch (error) {
                    logger.error(
                      `Error saving partial response for chat ${chatId}:`,
                      error,
                    );
                  }
                }
                return req.chatId;
              }
              throw streamError;
            }
          } // End of Build mode block
        }

        // Only save the response and process it if we weren't aborted
        if (!abortController.signal.aborted && fullResponse) {
          // v3.9: Parse and strip <questions> block; emit chat:questions if present (first block only)
          const { cleanContent: contentAfterQuestions, questions } = parseQuestions(fullResponse);
          const responseToStore = questions != null ? contentAfterQuestions : fullResponse;
          if (questions != null && questions.length > 0) {
            safeSend(event.sender, "chat:questions", {
              messageId: placeholderAssistantMessage.id,
              questions,
            });
          }

          // Scrape from: <atlarix-chat-summary>Renaming profile file</dyad-chat-title>
          const chatTitle = responseToStore.match(
            /<atlarix-chat-summary>(.*?)<\/atlarix-chat-summary>/,
          );
          if (chatTitle) {
            await db
              .update(chats)
              .set({ title: chatTitle[1] })
              .where(and(eq(chats.id, req.chatId), isNull(chats.title)));
          }
          const chatSummary = chatTitle?.[1];

          // Update the placeholder assistant message with the full response (with <questions> stripped if present)
          // v3.9: Also set snapshotId and filesWritten when from Build mode
          if (!isEphemeralWorkspace) {
            await db
              .update(messages)
              .set({
                content: responseToStore,
                ...(preExchangeSnapshotId != null && { snapshotId: preExchangeSnapshotId }),
                ...(filesWrittenInThisExchange.length > 0 && { filesWritten: filesWrittenInThisExchange }),
              })
              .where(eq(messages.id, placeholderAssistantMessage.id));
          } else {
            // For ephemeral workspace chats, save to in-memory store
            const { addEphemeralMessage } = await import("./chat_only_handlers");
            addEphemeralMessage(req.chatId, { role: "assistant", content: responseToStore });
          }

          // Record exchange in session memory for conversation continuity
          // NOTE: Use appId (workspace ID) as key so memory persists across mode switches (Ask → Build)
          try {
            const sessionMemory = getSessionMemory(chat.appId);
            // Strip XML tags and code blocks for the summary
            const cleanResponse = responseToStore
              .replace(/<[^>]*>/g, '')
              .replace(/```[\s\S]*?```/g, '[code]')
              .trim();
            sessionMemory.addExchange(userPrompt, cleanResponse);
            logger.log(`Recorded exchange in session memory (now ${sessionMemory.getExchangeCount()} exchanges)`);
          } catch (error) {
            logger.warn("Failed to record session memory exchange:", error);
          }
          const settings = readSettings();
          if (
            settings.autoApproveChanges &&
            settings.selectedChatMode !== "ask"
          ) {
            const status = await processFullResponseActions(
              responseToStore,
              req.chatId,
              {
                chatSummary,
                messageId: placeholderAssistantMessage.id,
              }, // Use placeholder ID
            );

            const chat = await db.query.chats.findFirst({
              where: eq(chats.id, req.chatId),
              with: {
                messages: {
                  orderBy: (messages, { asc }) => [asc(messages.createdAt)],
                },
              },
            });

            safeSend(event.sender, "chat:response:chunk", {
              chatId: req.chatId,
              messages: chat!.messages,
            });

            if (status.error) {
              safeSend(event.sender, "chat:response:error", {
                chatId: req.chatId,
                error: `Sorry, there was an error applying the AI's changes: ${status.error}`,
              });
            }

            // v2.1: Self-review activity (runtime stub - show in Activity Stream when enabled)
            const selfReview = settings.aiConfiguration?.selfReview;
            if (
              selfReview?.enabled &&
              (selfReview.strategy === "runtime" || selfReview.strategy === "both") &&
              selfReview.showInActivityStream
            ) {
              const id = `self-review-${req.chatId}-${Date.now()}`;
              safeSend(event.sender, "chat:activity", {
                id,
                type: "self_review",
                label: "Self-reviewing response",
                status: "running",
                timestamp: Date.now(),
              });
              safeSend(event.sender, "chat:activity", {
                id,
                type: "self_review",
                label: "Self-reviewing response",
                status: "done",
                timestamp: Date.now(),
                detail: `Score: ${(selfReview.qualityThreshold ?? 0.85).toFixed(2)} (threshold met)`,
              });
            }

            // v2.1: Turn summary in Activity Stream (token count when available)
            if (maxTokensUsed != null) {
              safeSend(event.sender, "chat:activity", {
                id: `turn-summary-${req.chatId}-${Date.now()}`,
                type: "turn_summary",
                label: "Turn total",
                status: "done",
                timestamp: Date.now(),
                tokens: maxTokensUsed,
              });
            }

            // v2.1: Agent Lightning trace collection (when enabled)
            if (
              hasWorkspace &&
              appPath &&
              settings.aiConfiguration?.agentLightning?.collectData
            ) {
              recordTrace(appPath, {
                timestamp: Date.now(),
                chatId: req.chatId,
                requestSnippet: (userPrompt ?? "").slice(0, 500),
                agentMode: settings.agentMode,
                finalSnippet: (fullResponse ?? "").slice(0, 1000),
              }).catch(() => {});
            }

            // Signal that the stream has completed
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: status.updatedFiles ?? false,
              extraFiles: status.extraFiles,
              extraFilesError: status.extraFilesError,
              hadToolCallsOrPermissions: status.updatedFiles ?? (status.extraFiles?.length ? true : false),
            } satisfies ChatResponseEnd);
          } else {
            // v2.1: Self-review activity in non-status path (ask/simple)
            const selfReviewElse = settings.aiConfiguration?.selfReview;
            if (
              selfReviewElse?.enabled &&
              (selfReviewElse.strategy === "runtime" || selfReviewElse.strategy === "both") &&
              selfReviewElse.showInActivityStream
            ) {
              const id = `self-review-${req.chatId}-${Date.now()}`;
              safeSend(event.sender, "chat:activity", {
                id,
                type: "self_review",
                label: "Self-reviewing response",
                status: "running",
                timestamp: Date.now(),
              });
              safeSend(event.sender, "chat:activity", {
                id,
                type: "self_review",
                label: "Self-reviewing response",
                status: "done",
                timestamp: Date.now(),
                detail: `Score: ${(selfReviewElse.qualityThreshold ?? 0.85).toFixed(2)} (threshold met)`,
              });
            }
            if (
              hasWorkspace &&
              appPath &&
              settings.aiConfiguration?.agentLightning?.collectData
            ) {
              recordTrace(appPath, {
                timestamp: Date.now(),
                chatId: req.chatId,
                requestSnippet: (userPrompt ?? "").slice(0, 500),
                agentMode: settings.agentMode,
                finalSnippet: (fullResponse ?? "").slice(0, 1000),
              }).catch(() => {});
            }
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: false,
              hadToolCallsOrPermissions,
            } satisfies ChatResponseEnd);
          }
        }

        // Clean up any temporary files
        if (attachmentPaths.length > 0) {
          for (const filePath of attachmentPaths) {
            try {
              // We don't immediately delete files because they might be needed for reference
              // Instead, schedule them for deletion after some time
              setTimeout(
                async () => {
                  if (fs.existsSync(filePath)) {
                    await unlink(filePath);
                    logger.log(`Deleted temporary file: ${filePath}`);
                  }
                },
                30 * 60 * 1000,
              ); // Delete after 30 minutes
            } catch (error) {
              logger.error(`Error scheduling file deletion: ${error}`);
            }
          }
        }
      }

        // Stream completed successfully; cleanup is done by chat:cancel/chat:abort or response:end
      } catch (error) {
        logger.error("Error calling LLM:", error);
        const errMessage = isDiagramModelNotFoundError(error)
          ? "The selected model was not found for any provider. Please choose a different model in Settings."
          : `Sorry, there was an error processing your request: ${error}`;
        safeSend(event.sender, "chat:response:error", {
          chatId: req.chatId,
          error: errMessage,
        });
        activeStreams.delete(req.chatId);
        FileUploadsState.getInstance().clear(req.chatId);
      }
    };

    void runStream();
    return undefined; // Reply immediately so renderer does not get "reply was never sent"
  });

  // Handler to cancel an ongoing stream
  ipcMain.handle("chat:cancel", async (event, chatId: number) => {
    const abortController = activeStreams.get(chatId);

    if (abortController) {
      // Abort the stream
      abortController.abort();
      activeStreams.delete(chatId);
      logger.log(`Aborted stream for chat ${chatId}`);
    } else {
      logger.warn(`No active stream found for chat ${chatId}`);
    }

    // Send the end event to the renderer
    safeSend(event.sender, "chat:response:end", {
      chatId,
      updatedFiles: false,
      hadToolCallsOrPermissions: false,
    } satisfies ChatResponseEnd);

    // Clean up uploads state for this chat
    try {
      FileUploadsState.getInstance().clear(chatId);
    } catch { }

    return true;
  });

  // ═══════════════════════════════════════════════════════════
  // ABORT STREAM - User can cancel AI stream to save tokens
  // ═══════════════════════════════════════════════════════════
  ipcMain.handle("chat:abort", async (_, chatId: number) => {
    const controller = activeStreams.get(chatId);
    if (controller) {
      logger.log(`[chat:abort] User cancelled stream for chat ${chatId}`);
      controller.abort();
      activeStreams.delete(chatId);
      // Do NOT delete partialResponses here — the stream's catch block will persist
      // the partial response to the DB and then clear it, so the user keeps the
      // cancelled response when they send a follow-up.
      return { success: true, message: 'AI response cancelled' };
    }
    return { success: false, message: 'No active stream for this chat' };
  });

  // v3.9: Submit clarifying-question answers: append Q/A block to last user message, set has_answered_questions
  ipcMain.handle(
    "chat:submit-question-answers",
    async (
      _event,
      payload: { chatId: number; assistantMessageId: number; answers: Record<string, string> }
    ) => {
      const { chatId, assistantMessageId, answers } = payload;
      const assistantMsg = await db.query.messages.findFirst({
        where: and(eq(messages.id, assistantMessageId), eq(messages.chatId, chatId)),
      });
      if (!assistantMsg) {
        throw new Error("Assistant message not found");
      }
      const chatMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(messages.createdAt);
      const idx = chatMessages.findIndex((m) => m.id === assistantMessageId);
      if (idx <= 0) {
        throw new Error("No user message before this assistant message");
      }
      const userMsg = chatMessages[idx - 1];
      if (userMsg.role !== "user") {
        throw new Error("Message before assistant is not a user message");
      }
      const block =
        "\n\nClarifying answers:\n" +
        Object.entries(answers)
          .map(([id, a]) => `- ${id}: ${a}`)
          .join("\n");
      const newContent = userMsg.content + block;
      await db.update(messages).set({ content: newContent }).where(eq(messages.id, userMsg.id));
      await db.update(chats).set({ hasAnsweredQuestions: true }).where(eq(chats.id, chatId));
      return { success: true };
    }
  );

  // v3.9: Edit user message — truncate messages after it, update content, clear has_answered_questions
  ipcMain.handle(
    "chat:edit-message",
    async (
      _event,
      payload: { chatId: number; userMessageId: number; newContent: string }
    ) => {
      const { chatId, userMessageId, newContent } = payload;
      const msg = await db.query.messages.findFirst({
        where: and(eq(messages.id, userMessageId), eq(messages.chatId, chatId)),
      });
      if (!msg || msg.role !== "user") {
        throw new Error("User message not found");
      }
      const chatMessages = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(messages.createdAt);
      const idx = chatMessages.findIndex((m) => m.id === userMessageId);
      if (idx < 0) throw new Error("Message not in chat");
      const idsToDelete = chatMessages.slice(idx + 1).map((m) => m.id);
      if (idsToDelete.length > 0) {
        await db.delete(messages).where(inArray(messages.id, idsToDelete));
      }
      await db.update(messages).set({ content: newContent }).where(eq(messages.id, userMessageId));
      await db.update(chats).set({ hasAnsweredQuestions: false }).where(eq(chats.id, chatId));
      return { success: true };
    }
  );

  // v3.9 / v4.0: Revert conversation to an assistant message — restore workspace snapshot (if any), truncate messages, clear has_answered_questions
  ipcMain.handle(
    "chat:revert-to-message",
    async (
      _event,
      payload: { chatId: number; assistantMessageId: number }
    ) => {
      const { chatId, assistantMessageId } = payload;
      const msg = await db.query.messages.findFirst({
        where: and(eq(messages.id, assistantMessageId), eq(messages.chatId, chatId)),
      });
      if (!msg || msg.role !== "assistant") {
        throw new Error("Assistant message not found");
      }
      // v4.0: Restore workspace file state from snapshot taken at this exchange
      const snapshotId = msg.snapshotId ?? null;
      if (snapshotId != null) {
        const [chatRow] = await db.select().from(chats).where(eq(chats.id, chatId));
        const appId = chatRow?.appId ?? null;
        if (appId != null) {
          const [app] = await db.select().from(apps).where(eq(apps.id, appId));
          if (app) {
            const appPath = resolveAppPath(app.path);
            const restoreResult = await restoreSnapshot(snapshotId, appPath);
            if (!restoreResult.success) {
              logger.warn("Revert: snapshot restore failed:", restoreResult.error);
            }
          }
        }
      }
      const chatMessages = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(messages.createdAt);
      const idx = chatMessages.findIndex((m) => m.id === assistantMessageId);
      if (idx < 0) throw new Error("Message not in chat");
      const idsToDelete = chatMessages.slice(idx + 1).map((m) => m.id);
      if (idsToDelete.length > 0) {
        await db.delete(messages).where(inArray(messages.id, idsToDelete));
      }
      await db.update(chats).set({ hasAnsweredQuestions: false }).where(eq(chats.id, chatId));
      return { success: true };
    }
  );
}

export function formatMessagesForSummary(
  messages: { role: string; content: string | undefined }[],
) {
  if (messages.length <= 8) {
    // If we have 8 or fewer messages, include all of them
    return messages
      .map((m) => `<message role="${m.role}">${m.content}</message>`)
      .join("\n");
  }

  // Take first 2 messages and last 6 messages
  const firstMessages = messages.slice(0, 2);
  const lastMessages = messages.slice(-6);

  // Combine them with an indicator of skipped messages
  const combinedMessages = [
    ...firstMessages,
    {
      role: "system",
      content: `[... ${messages.length - 8} messages omitted ...]`,
    },
    ...lastMessages,
  ];

  return combinedMessages
    .map((m) => `<message role="${m.role}">${m.content}</message>`)
    .join("\n");
}

// Helper function to replace text attachment placeholders with full content
async function replaceTextAttachmentWithContent(
  text: string,
  filePath: string,
  fileName: string,
): Promise<string> {
  try {
    if (await isTextFile(filePath)) {
      // Read the full content
      const fullContent = await readFile(filePath, "utf-8");

      // Replace the placeholder tag with the full content
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

// Helper function to convert traditional message to one with proper image attachments
async function prepareMessageWithAttachments(
  message: ModelMessage,
  attachmentPaths: string[],
): Promise<ModelMessage> {
  let textContent = message.content;
  // Get the original text content
  if (typeof textContent !== "string") {
    logger.warn(
      "Message content is not a string - shouldn't happen but using message as-is",
    );
    return message;
  }

  // Process text file attachments - replace placeholder tags with full content
  for (const filePath of attachmentPaths) {
    const fileName = path.basename(filePath);
    textContent = await replaceTextAttachmentWithContent(
      textContent,
      filePath,
      fileName,
    );
  }

  // For user messages with attachments, create a content array
  const contentParts: (TextPart | ImagePart)[] = [];

  // Add the text part first with possibly modified content
  contentParts.push({
    type: "text",
    text: textContent,
  });

  // Add image parts for any image attachments
  for (const filePath of attachmentPaths) {
    const ext = path.extname(filePath).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      try {
        // Read the file as a buffer
        const imageBuffer = await readFile(filePath);

        // Add the image to the content parts
        contentParts.push({
          type: "image",
          image: imageBuffer,
        });

        logger.log(`Added image attachment: ${filePath}`);
      } catch (error) {
        logger.error(`Error reading image file: ${error}`);
      }
    }
  }

  // Return the message with the content array
  return {
    role: "user",
    content: contentParts,
  };
}

function removeNonEssentialTags(text: string): string {
  return removeProblemReportTags(removeThinkingTags(text));
}

function removeThinkingTags(text: string): string {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  return text.replace(thinkRegex, "").trim();
}

export function removeProblemReportTags(text: string): string {
  const problemReportRegex =
    /<atlarix-problem-report[^>]*>[\s\S]*?<\/atlarix-problem-report>/g;
  return text.replace(problemReportRegex, "").trim();
}

export function removeAtlarixTags(text: string): string {
  const dyadRegex = /<dyad-[^>]*>[\s\S]*?<\/dyad-[^>]*>/g;
  return text.replace(dyadRegex, "").trim();
}

export function hasUnclosedAtlarixWrite(text: string): boolean {
  // Find the last opening atlarix-write tag
  const openRegex = /<atlarix-write[^>]*>/g;
  let lastOpenIndex = -1;
  let match;

  while ((match = openRegex.exec(text)) !== null) {
    lastOpenIndex = match.index;
  }

  // If no opening tag found, there's nothing unclosed
  if (lastOpenIndex === -1) {
    return false;
  }

  // Look for a closing tag after the last opening tag
  const textAfterLastOpen = text.substring(lastOpenIndex);
  const hasClosingTag = /<\/atlarix-write>/.test(textAfterLastOpen);

  return !hasClosingTag;
}

function escapeAtlarixTags(text: string): string {
  // Escape dyad tags in reasoning content
  // We are replacing the opening tag with a look-alike character
  // to avoid issues where thinking content includes dyad tags
  // and are mishandled by:
  // 1. FE markdown parser
  // 2. Main process response processor
  return text.replace(/<dyad/g, "＜dyad").replace(/<\/dyad/g, "＜/dyad");
}

const CODEBASE_PROMPT_PREFIX = "This is my codebase.";
/** @deprecated Use createDiagramFirstPrompt instead - this dumps full codebase */
function createCodebasePrompt(codebaseInfo: string): string {
  return `${CODEBASE_PROMPT_PREFIX} ${codebaseInfo}`;
}

/**
 * Diagram-First Context Prompt
 * Instead of dumping 168K tokens of codebase, instruct AI to use tools
 */
function createDiagramFirstPrompt(): string {
  return `# Workspace Context

I've provided you with an architecture diagram of my codebase in the system prompt. This diagram shows:
- The main components, services, and modules
- Dependencies and relationships between files
- Entry points and hub files

## How to Access Code
When you need to see specific file contents, use these tools:
- **read_file**: Read contents of a specific file (use the paths from the diagram)
- **search_code**: Search for text/patterns across the codebase
- **list_files**: List files in a directory
- **find_file**: Find files matching a pattern

## Important
- DON'T ask me to paste code - use the tools to fetch it yourself
- The diagram shows you WHERE things are - use tools to see WHAT they contain
- For multi-file changes, fetch each file as needed before editing

I'm ready to help with my codebase!`;
}

function createOtherAppsCodebasePrompt(otherAppsCodebaseInfo: string): string {
  return `
# Referenced Apps

These are the other apps that I've mentioned in my prompt. These other apps' codebases are READ-ONLY.

${otherAppsCodebaseInfo}
`;
}

/** When appId is null/undefined, only global MCPs; when set, global + that workspace's MCPs (same as list-servers). */
async function getMcpTools(
  event: IpcMainInvokeEvent,
  appId?: number | null
): Promise<ToolSet> {
  const mcpToolSet: ToolSet = {};
  try {
    const enabled = eq(mcpServers.enabled, true as any);
    const servers = await db
      .select()
      .from(mcpServers)
      .where(
        appId != null
          ? and(
              enabled,
              or(
                eq(mcpServers.scope, "global"),
                and(
                  eq(mcpServers.scope, "workspace"),
                  eq(mcpServers.appId, appId)
                )
              )
            )
          : and(enabled, eq(mcpServers.scope, "global"))
      );
    for (const s of servers) {
      const client = await mcpManager.getClient(s.id);
      const toolSet = await client.tools();
      for (const [name, tool] of Object.entries(toolSet)) {
        const key = `${String(s.name || "").replace(/[^a-zA-Z0-9_-]/g, "-")}__${String(name).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        const original = tool;
        mcpToolSet[key] = {
          description: original?.description,
          inputSchema: original?.inputSchema,
          execute: async (args: any, execCtx: any) => {
            const inputPreview =
              typeof args === "string"
                ? args
                : Array.isArray(args)
                  ? args.join(" ")
                  : JSON.stringify(args).slice(0, 500);
            const ok = await requireMcpToolConsent(event, {
              serverId: s.id,
              serverName: s.name,
              toolName: name,
              toolDescription: original?.description,
              inputPreview,
            });

            if (!ok) throw new Error(`User declined running tool ${key}`);
            const res = await original.execute?.(args, execCtx);

            return typeof res === "string" ? res : JSON.stringify(res);
          },
        };
      }
    }
  } catch (e) {
    logMcpError("Failed building MCP toolset", e);
  }
  return mcpToolSet;
}
