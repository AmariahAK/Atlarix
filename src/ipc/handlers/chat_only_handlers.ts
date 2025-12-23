/**
 * Chat-Only Stream Handlers
 * =========================
 * Simplified handler for chat-only sessions (no workspace/app)
 * 
 * This provides:
 * - 5 core tools: web_search, read_url, get_current_time, parse_url, request_tools
 * - No codebase context
 * - No file operations
 * - Simple, fast responses
 */

import { IpcMainInvokeEvent } from "electron";
import { streamText, ToolSet } from "ai";
import { db } from "../../db";
import { chats, messages } from "../../db/schema";
import { eq } from "drizzle-orm";
import { readSettings } from "../../main/settings";
import { getModelClient } from "../utils/get_model_client";
import { safeSend } from "../utils/safe_sender";
import log from "electron-log";
import { ChatStreamParams, ChatResponseEnd } from "../ipc_types";
import { ToolRegistry } from "../../lib/tools";
import { generateSimpleChatName } from "../../utils/chat_naming";
import { getMaxTokens, getTemperature } from "../utils/token_utils";
import { getExtraProviderOptions } from "../utils/thinking_utils";

const logger = log.scope("chat_only_handlers");

// Active streams for cancellation
const activeStreams = new Map<number, AbortController>();

// System prompt for chat-only mode
const CHAT_ONLY_SYSTEM_PROMPT = `You are Atlarix, a helpful AI assistant.

## Your Capabilities
You can help users with:
- Answering questions on any topic
- Web research using web_search tool
- Reading web pages with read_url tool
- Providing current date/time
- Parsing and analyzing URLs
- Planning projects before building

## When User Wants to Build Something
If the user asks to create an app, website, or project, you should:
1. First understand their requirements
2. Ask clarifying questions if needed
3. Then call create_workspace() to set up a project

After creating a workspace, you'll gain access to file tools (read_file, write_file, git, etc.)

## Important
- Be helpful and conversational
- Use web_search for current events, news, documentation
- For building: always call create_workspace first
`;

/**
 * Handle chat-only stream request (no workspace)
 */
export async function handleChatOnlyStream(
    event: IpcMainInvokeEvent,
    req: ChatStreamParams,
    abortController: AbortController
): Promise<string> {
    logger.log("Starting chat-only stream for chat:", req.chatId);

    try {
        const settings = await readSettings();

        // Get the chat from database
        const chat = await db.query.chats.findFirst({
            where: eq(chats.id, req.chatId),
            with: {
                messages: {
                    orderBy: (msgs, { asc }) => [asc(msgs.createdAt)],
                },
            },
        });

        if (!chat) {
            throw new Error("Chat not found");
        }

        // Store user message
        const [newMessage] = await db
            .insert(messages)
            .values({
                chatId: req.chatId,
                role: "user",
                content: req.prompt,
            })
            .returning();

        // Update chat with new message
        const updatedMessages = [...chat.messages, newMessage];

        // Generate chat name if first message
        if (!chat.title && updatedMessages.length === 1) {
            const simpleName = generateSimpleChatName(req.prompt);
            await db
                .update(chats)
                .set({ title: simpleName })
                .where(eq(chats.id, req.chatId));
            logger.info(`Set chat ${req.chatId} name: "${simpleName}"`);
        }

        // Send initial messages to UI
        safeSend(event.sender, "chat:response:chunk", {
            chatId: req.chatId,
            messages: updatedMessages,
        });

        // Get model client
        const { modelClient } = await getModelClient(
            settings.selectedModel,
            settings
        );

        // Get chat-only tools (5 core tools + workspace tools)
        const availableTools = ToolRegistry.getToolsForContext(false);
        logger.log(`Chat-only mode: ${availableTools.length} tools available`);

        // Convert tools to AI SDK format
        const tools: ToolSet = {};
        for (const tool of availableTools) {
            tools[tool.name] = {
                description: tool.description,
                parameters: tool.parameters,
                execute: async (params: any) => {
                    logger.log(`Executing tool: ${tool.name}`);
                    const result = await tool.handler({ ...params, chatId: req.chatId });
                    return result;
                },
            };
        }

        // Prepare message history
        const messageHistory = updatedMessages.map((msg) => ({
            role: msg.role as "user" | "assistant" | "system",
            content: msg.content,
        }));

        // Stream response from AI
        let fullResponse = "";
        const result = streamText({
            model: modelClient.languageModel,
            system: CHAT_ONLY_SYSTEM_PROMPT,
            messages: messageHistory,
            tools,
            maxTokens: getMaxTokens(settings),
            temperature: getTemperature(settings.selectedModel),
            abortSignal: abortController.signal,
            ...getExtraProviderOptions(settings),
        });

        // Process stream
        for await (const chunk of result.textStream) {
            if (abortController.signal.aborted) {
                logger.log("Chat-only stream aborted");
                break;
            }

            fullResponse += chunk;

            // Send chunk to UI
            safeSend(event.sender, "chat:response:chunk", {
                chatId: req.chatId,
                messages: [
                    ...updatedMessages,
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

        // Save assistant response to database
        const [assistantMessage] = await db
            .insert(messages)
            .values({
                chatId: req.chatId,
                role: "assistant",
                content: fullResponse,
            })
            .returning();

        // Send completion
        const endResponse: ChatResponseEnd = {
            chatId: req.chatId,
            messages: [...updatedMessages, assistantMessage],
        };
        safeSend(event.sender, "chat:response:end", endResponse);

        // Clean up
        activeStreams.delete(req.chatId);

        logger.log("Chat-only stream completed successfully");
        return fullResponse;

    } catch (error) {
        logger.error("Error in chat-only stream:", error);
        safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            error: `Sorry, there was an error: ${error}`,
        });
        activeStreams.delete(req.chatId);
        throw error;
    }
}

/**
 * Check if a chat is chat-only (no workspace)
 */
export async function isChatOnly(chatId: number): Promise<boolean> {
    const chat = await db.query.chats.findFirst({
        where: eq(chats.id, chatId),
        columns: { appId: true },
    });
    return !chat?.appId;
}
