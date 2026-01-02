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
import { and, eq, isNull } from "drizzle-orm";
import type { SmartContextMode } from "../../lib/schemas";
import {
  constructSystemPrompt,
  readAiRules,
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
import { getModelClient, ModelClient } from "../utils/get_model_client";
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
import { cleanFullResponse } from "../utils/cleanFullResponse";
import { generateProblemReport } from "../processors/tsc";
import { createProblemFixPrompt } from "@/shared/problem_prompt";
import { AsyncVirtualFileSystem } from "../../../shared/VirtualFilesystem";
import {
  getAtlarixAddDependencyTags,
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
import z from "zod";
import { isTurboEditsV2Enabled } from "@/lib/schemas";
import { AI_STREAMING_ERROR_MESSAGE_PREFIX } from "@/shared/texts";
import { getCurrentCommitHash } from "../utils/git_utils";
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
import { handleChatOnlyStream } from "./chat_only_handlers";
import { getWorkspaceContext } from "./chat_stream/workspace-context";
import { PermissionInterceptor } from "./permissions/interceptor";
import { registerInterceptor } from "./permissions/handlers";
import { getSessionMemory, clearSessionMemory } from "../../lib/session-memory";


type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;

const logger = log.scope("chat_stream_handlers");

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
  ipcMain.handle("chat:stream", async (event, req: ChatStreamParams) => {
    try {
      const fileUploadsState = FileUploadsState.getInstance();
      let dyadRequestId: string | undefined;
      // Create an AbortController for this stream
      const abortController = new AbortController();
      activeStreams.set(req.chatId, abortController);

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
          // This is a pure chat-only (no workspace) - use simplified handler
          logger.log(`Chat ${req.chatId} is ephemeral chat-only mode (incognito)`);
          return await handleChatOnlyStream(event, req, abortController);
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

        // Chat-only mode: route to simplified handler (no workspace/codebase)
        if (!chat.app) {
          logger.log(`Chat ${req.chatId} is chat-only mode (no workspace)`);
          return await handleChatOnlyStream(event, req, abortController);
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

      // Process attachments if any
      let attachmentInfo = "";
      let attachmentPaths: string[] = [];

      if (req.attachments && req.attachments.length > 0) {
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

      // Add user message to database with attachment info
      let userPrompt = req.prompt + (attachmentInfo ? attachmentInfo : "");
      // Inline referenced prompt contents for mentions like @prompt:<id>
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

      const componentsToProcess = req.selectedComponents || [];

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

      // Only save to database for non-ephemeral chats
      if (!isEphemeralWorkspace) {
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
        // For ephemeral chats, add message to in-memory store
        const { addEphemeralMessage, getEphemeralChat } = await import("./chat_only_handlers");
        addEphemeralMessage(req.chatId, { role: "user", content: userPrompt });

        // Get existing messages from ephemeral store to include full history
        const ephemeralChat = getEphemeralChat(req.chatId);
        const existingMessages = ephemeralChat?.messages || [];

        // Create the new user message and placeholder assistant
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

        // Include ALL previous messages plus the new exchange
        // Filter out the current user message if already added to avoid duplication
        const previousMessages = existingMessages.filter(
          (m: any) => m.id !== newUserMessage.id
        );
        updatedChat.messages = [...previousMessages, newUserMessage, placeholderMessage];

        // Update placeholderAssistantMessage so token logging uses correct ID
        placeholderAssistantMessage = placeholderMessage;
      }

      // Send the messages right away so that the loading state is shown for the message.
      safeSend(event.sender, "chat:response:chunk", {
        chatId: req.chatId,
        messages: updatedChat.messages,
      });

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
        const { modelClient, isEngineEnabled, isSmartContextEnabled } =
          await getModelClient(settings.selectedModel, settings);

        // Chat-only mode: no app/workspace
        const hasWorkspace = !!updatedChat.app;

        let appPath = "";
        let codebaseInfo = "";
        let files: any[] = [];
        let chatContext: any = { contextPaths: [], smartContextAutoIncludes: [] };

        if (hasWorkspace) {
          appPath = resolveAppPath(updatedChat.app.path);
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
              : validateChatContext(updatedChat.app.chatContext);

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
          updatedChat.app!.id, // Exclude current app
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

          // Prepare message history for the AI
          const messageHistory = updatedChat.messages.map((message) => ({
            role: message.role as "user" | "assistant" | "system",
            content: message.content,
            sourceCommitHash: message.sourceCommitHash,
            commitHash: message.commitHash,
          }));

          // For Atlarix Pro + Deep Context, we set to 200 chat turns (+1)
          // this is to enable more cache hits. Practically, users should
          // rarely go over this limit because they will hit the model's
          // context window limit.
          //
          // Limit chat history based on maxChatTurnsInContext setting
          // We add 1 because the current prompt counts as a turn.
          const maxChatTurns = isDeepContextEnabled
            ? 201
            : (settings.maxChatTurnsInContext || MAX_CHAT_TURNS_IN_CONTEXT) + 1;

          // If we need to limit the context, we take only the most recent turns
          let limitedMessageHistory = messageHistory;
          if (messageHistory.length > maxChatTurns * 2) {
            // Each turn is a user + assistant pair
            // Calculate how many messages to keep (maxChatTurns * 2)
            let recentMessages = messageHistory
              .filter((msg) => msg.role !== "system")
              .slice(-maxChatTurns * 2);

            // Ensure the first message is a user message
            if (recentMessages.length > 0 && recentMessages[0].role !== "user") {
              // Find the first user message
              const firstUserIndex = recentMessages.findIndex(
                (msg) => msg.role === "user",
              );
              if (firstUserIndex > 0) {
                // Drop assistant messages before the first user message
                recentMessages = recentMessages.slice(firstUserIndex);
              } else if (firstUserIndex === -1) {
                logger.warn(
                  "No user messages found in recent history, set recent messages to empty",
                );
                recentMessages = [];
              }
            }

            limitedMessageHistory = [...recentMessages];

            logger.log(
              `Limiting chat history from ${messageHistory.length} to ${limitedMessageHistory.length} messages (max ${maxChatTurns} turns)`,
            );
          }

          let systemPrompt = constructSystemPrompt({
            aiRules: await readAiRules(resolveAppPath(updatedChat.app.path)),
            chatMode:
              settings.selectedChatMode === "agent"
                ? "build"
                : settings.selectedChatMode,
            enableTurboEditsV2: isTurboEditsV2Enabled(settings),
          });

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
                    workspaceId: req.appId,
                    chatId: isEphemeralChat ? null : req.chatId,
                    type: "architecture",
                    title: `Architecture - ${workspaceContext.summary}`,
                    content: workspaceContext.diagram,
                    metadata: { summary: workspaceContext.summary },
                  });
                  logger.info(`Saved workspace diagram to database for appId: ${req.appId}`);
                } catch (dbError) {
                  logger.warn("Failed to save diagram to database:", dbError);
                }
              }
            }
          } catch (error) {
            logger.warn("Failed to inject workspace context:", error);
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
              const appPath = resolveAppPath(updatedChat.app.path);
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
            updatedChat.app?.supabaseProjectId &&
            settings.supabase?.accessToken?.value
          ) {
            systemPrompt +=
              "\n\n" +
              SUPABASE_AVAILABLE_SYSTEM_PROMPT +
              "\n\n" +
              (await getSupabaseContext({
                supabaseProjectId: updatedChat.app.supabaseProjectId,
              }));
          } else if (
            // Neon projects don't need Supabase.
            !updatedChat.app?.neonProjectId &&
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

          const limitedHistoryChatMessages = limitedMessageHistory.map((msg) => ({
            role: msg.role as "user" | "assistant" | "system",
            // Why remove thinking tags?
            // Thinking tags are generally not critical for the context
            // and eats up extra tokens.
            content:
              settings.selectedChatMode === "ask"
                ? removeAtlarixTags(removeNonEssentialTags(msg.content))
                : removeNonEssentialTags(msg.content),
            providerOptions: {
              "dyad-engine": {
                sourceCommitHash: msg.sourceCommitHash,
                commitHash: msg.commitHash,
              },
            },
          }));

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
                dyadAppId: updatedChat.app.id,
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
            const selectedModelName = settings.selectedModel.name || "";
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
              maxOutputTokens: await getMaxTokens(settings.selectedModel),
              temperature: await getTemperature(settings.selectedModel),
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
                } else {
                  logger.log("Total tokens used: unknown");
                }
              },
              onError: (error: any) => {
                let errorMessage = (error as any)?.error?.message;
                const responseBody = error?.error?.responseBody;
                if (errorMessage && responseBody) {
                  errorMessage += "\n\nDetails: " + responseBody;
                }
                const message = errorMessage || JSON.stringify(error);
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
              updatedChat.app?.supabaseProjectId
            ) {
              const supabaseClientCode = await getSupabaseClientCode({
                projectId: updatedChat.app?.supabaseProjectId,
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
            // Workspace-aware tool filtering
            const hasWorkspace = !!updatedChat.app;
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

            const { fullStream } = await simpleStreamText({
              chatMessages: limitedHistoryChatMessages,
              modelClient,
              tools,
              systemPromptOverride: constructSystemPrompt({
                aiRules: await readAiRules(resolveAppPath(updatedChat.app.path)),
                chatMode: "agent",
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

          // Ask mode with workspace: use read-only tools for exploration
          if (settings.selectedChatMode === "ask" && updatedChat.app) {
            logger.log("Ask mode with workspace - enabling read-only tools");

            // Get read-only tools for Ask mode
            const askModeTools = ToolRegistry.getToolsForAskMode();

            // Convert to tool set format expected by AI SDK
            const askTools: ToolSet = {};
            for (const tool of askModeTools) {
              askTools[tool.name] = {
                description: tool.description,
                parameters: tool.parameters,
                execute: async (args: any) => {
                  try {
                    // Execute tool via registry
                    const execResult = await ToolRegistry.execute(tool.name, {
                      ...args,
                      workspace: resolveAppPath(updatedChat.app.path),
                    });

                    // Return formatted result for display
                    return JSON.stringify(execResult);
                  } catch (error) {
                    return JSON.stringify({ success: false, error: String(error) });
                  }
                },
              };
            }

            logger.log(`Ask mode: ${Object.keys(askTools).length} read-only tools available`);

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

NOT available in Ask mode (Build mode only):
- write_file, delete_file, rename_file: File modifications
- run_command, run_tests: Command execution
- save_learning: Memory modifications

If the user requests modifications, politely explain that Ask mode is for exploration only and suggest switching to Build mode for changes.`;

            const { fullStream: askStream } = await simpleStreamText({
              chatMessages,
              modelClient,
              tools: askTools,
              systemPromptOverride: constructSystemPrompt({
                aiRules: await readAiRules(resolveAppPath(updatedChat.app.path)),
                chatMode: "ask",
                enableTurboEditsV2: false,
              }) + askModePrompt,
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

            const hasWorkspace = !!updatedChat.app;
            const workspacePath = updatedChat.app?.path ? resolveAppPath(updatedChat.app.path) : "";
            const buildModeTools = ToolRegistry.toAISDKFormatForContext(hasWorkspace);

            // Create permission interceptor for this session
            const permissionInterceptor = new PermissionInterceptor(workspacePath);

            // Register interceptor for IPC handlers (so UI can approve/reject)
            registerInterceptor(req.chatId, permissionInterceptor);

            // Listen for terminal output events and forward to frontend
            permissionInterceptor.on('terminal-output', (payload: any) => {
              safeSend(event.sender, "terminal-output", {
                chatId: req.chatId,
                commandId: payload.operationId,
                command: payload.command,
                output: payload.output,
                status: payload.status,
                exitCode: payload.exitCode,
              });
              logger.log(`[Build Mode] Terminal output sent: ${payload.command} (${payload.status})`);
            });

            // Convert to tool set format expected by AI SDK
            const tools: ToolSet = {};
            for (const tool of buildModeTools) {
              tools[tool.function.name] = {
                description: tool.function.description,
                parameters: tool.function.parameters,
                execute: async (args: any) => {
                  // Execute tool via registry, inject workspace path AND chatMode
                  const result = await ToolRegistry.execute(tool.function.name, {
                    ...args,
                    workspace: workspacePath || undefined,
                    chatMode: "build", // Pass chatMode so handlers can check permissions
                  });

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
                },
              };
            }

            logger.log(`Build mode: ${Object.keys(tools).length} tools available`);

            // ═══════════════════════════════════════════════════════════════
            // AGENTIC TOOL LOOP
            // For models that use text-based tool calls (MiniMax, etc.),
            // we need to loop: execute tools → feed results back → let AI continue
            // ═══════════════════════════════════════════════════════════════
            const MAX_AGENTIC_ITERATIONS = 5;
            let agenticIteration = 0;
            let agenticMessages = [...chatMessages]; // Copy current messages
            let allToolResults: { tool: string; result: string }[] = [];

            const { containsTextToolCall, parseTextToolCalls, stripToolCallXML } = await import("../utils/text_tool_parser");

            try {
              while (agenticIteration < MAX_AGENTIC_ITERATIONS) {
                logger.log(`[Agentic Loop] Iteration ${agenticIteration + 1}/${MAX_AGENTIC_ITERATIONS}`);

                const { fullStream } = await simpleStreamText({
                  chatMessages: agenticMessages,
                  modelClient,
                  tools,
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

                // Check for text-based tool calls (MiniMax, Claude XML, etc.)
                if (!containsTextToolCall(fullResponse)) {
                  logger.log("[Agentic Loop] No text-based tool calls detected, ending loop");
                  break;
                }

                logger.log("[Agentic Loop] Detected text-based tool calls, parsing and executing...");
                const textToolCalls = parseTextToolCalls(fullResponse);

                if (textToolCalls.length === 0) {
                  logger.log("[Agentic Loop] No parseable tool calls found, ending loop");
                  break;
                }

                // Execute all text-based tools
                const iterationResults: { tool: string; result: string }[] = [];
                let hasPermissionRequest = false;

                for (const toolCall of textToolCalls) {
                  try {
                    if (!tools[toolCall.toolName]) {
                      logger.warn(`[Agentic Loop] Unknown tool: ${toolCall.toolName}`);
                      iterationResults.push({
                        tool: toolCall.toolName,
                        result: `Error: Unknown tool "${toolCall.toolName}"`,
                      });
                      continue;
                    }

                    logger.log(`[Agentic Loop] Executing: ${toolCall.toolName}`, toolCall.args);

                    // Add workspace path to args
                    const argsWithWorkspace = {
                      ...toolCall.args,
                      workspace: workspacePath || undefined,
                      chatMode: "build",
                    };

                    // Execute tool
                    const toolResult = await ToolRegistry.execute(toolCall.toolName, argsWithWorkspace);

                    // Check if this is a permission request
                    if (permissionInterceptor.isPermissionRequest(toolResult)) {
                      const permRequest = permissionInterceptor.parsePermissionRequest(toolResult);
                      if (permRequest) {
                        const operationId = permissionInterceptor.generateOperationId();
                        permissionInterceptor.bufferOperation(operationId, permRequest);

                        // Send permission request to frontend
                        safeSend(event.sender, "permission-request", {
                          chatId: req.chatId,
                          operationId,
                          request: permRequest,
                        });

                        logger.log(`[Agentic Loop] Permission request buffered: ${operationId}`);
                        hasPermissionRequest = true;

                        // Wait for approval
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
                            // Check if command failure vs user rejection
                            const execResult = permissionInterceptor.getExecutionResult(operationId);

                            if (execResult.exitCode !== undefined) {
                              // Command failed - include terminal output for AI
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
                              // User rejected
                              iterationResults.push({
                                tool: toolCall.toolName,
                                result: JSON.stringify({
                                  success: false,
                                  error: "Permission denied by user",
                                }),
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
                      // Tool executed directly
                      const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                      iterationResults.push({
                        tool: toolCall.toolName,
                        result: resultStr,
                      });
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

                // Reset fullResponse for next iteration (AI will generate new response)
                fullResponse = '';
                agenticIteration++;

                // If we hit permission requests, the AI should continue after approval
                if (hasPermissionRequest) {
                  logger.log("[Agentic Loop] Had permission requests, continuing loop...");
                }
              }

              if (agenticIteration >= MAX_AGENTIC_ITERATIONS) {
                logger.warn(`[Agentic Loop] Hit max iterations (${MAX_AGENTIC_ITERATIONS})`);
              }

              logger.log(`[Agentic Loop] Completed after ${agenticIteration + 1} iteration(s), ${allToolResults.length} tools executed`);
              // ═══════════════════════════════════════════════════════════════

            } catch (streamError) {
              // Check if this was an abort error
              if (abortController.signal.aborted) {
                const chatId = req.chatId;
                const partialResponse = partialResponses.get(req.chatId);
                // If we have a partial response, save it to the database
                if (partialResponse) {
                  try {
                    // Update the placeholder assistant message with the partial content and cancellation note
                    // Only for non-ephemeral chats
                    if (!isEphemeralWorkspace) {
                      await db
                        .update(messages)
                        .set({
                          content: `${partialResponse}

[Response cancelled by user]`,
                        })
                        .where(eq(messages.id, placeholderAssistantMessage.id));

                      logger.log(
                        `Updated cancelled response for placeholder message ${placeholderAssistantMessage.id} in chat ${chatId}`,
                      );
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
          // Scrape from: <atlarix-chat-summary>Renaming profile file</dyad-chat-title>
          const chatTitle = fullResponse.match(
            /<atlarix-chat-summary>(.*?)<\/atlarix-chat-summary>/,
          );
          if (chatTitle) {
            await db
              .update(chats)
              .set({ title: chatTitle[1] })
              .where(and(eq(chats.id, req.chatId), isNull(chats.title)));
          }
          const chatSummary = chatTitle?.[1];

          // Update the placeholder assistant message with the full response
          // Only for non-ephemeral chats
          if (!isEphemeralWorkspace) {
            await db
              .update(messages)
              .set({ content: fullResponse })
              .where(eq(messages.id, placeholderAssistantMessage.id));
          } else {
            // For ephemeral workspace chats, save to in-memory store
            const { addEphemeralMessage } = await import("./chat_only_handlers");
            addEphemeralMessage(req.chatId, { role: "assistant", content: fullResponse });
          }

          // Record exchange in session memory for conversation continuity
          // NOTE: Use appId (workspace ID) as key so memory persists across mode switches (Ask → Build)
          try {
            const sessionMemory = getSessionMemory(chat.appId);
            // Strip XML tags and code blocks for the summary
            const cleanResponse = fullResponse
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
              fullResponse,
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

            // Signal that the stream has completed
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: status.updatedFiles ?? false,
              extraFiles: status.extraFiles,
              extraFilesError: status.extraFilesError,
            } satisfies ChatResponseEnd);
          } else {
            safeSend(event.sender, "chat:response:end", {
              chatId: req.chatId,
              updatedFiles: false,
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

      // Return the chat ID for backwards compatibility
      return req.chatId;
    } catch (error) {
      logger.error("Error calling LLM:", error);
      safeSend(event.sender, "chat:response:error", {
        chatId: req.chatId,
        error: `Sorry, there was an error processing your request: ${error}`,
      });
      // Clean up the abort controller
      activeStreams.delete(req.chatId);
      // Clean up file uploads state on error
      FileUploadsState.getInstance().clear(req.chatId);
      return "error";
    }
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
      partialResponses.delete(chatId);
      return { success: true, message: 'AI response cancelled' };
    }
    return { success: false, message: 'No active stream for this chat' };
  });
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

async function getMcpTools(event: IpcMainInvokeEvent): Promise<ToolSet> {
  const mcpToolSet: ToolSet = {};
  try {
    const servers = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true as any));
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
    logger.warn("Failed building MCP toolset", e);
  }
  return mcpToolSet;
}
