/**
 * Chat-Only Stream Handlers (Ephemeral/Incognito Mode)
 * =====================================================
 * Simplified handler for chat-only sessions (no workspace/app)
 * 
 * This provides:
 * - 5 core tools: web_search, read_url, get_current_time, parse_url, request_tools
 * - No codebase context
 * - No file operations
 * - Simple, fast responses
 * - NO DATABASE STORAGE (incognito mode - chat disappears on close)
 */

import { IpcMainInvokeEvent } from "electron";
import { streamText, ToolSet, stepCountIs } from "ai";
import { readSettings } from "../../main/settings";
import { getModelClient } from "../utils/get_model_client";
import { safeSend } from "../utils/safe_sender";
import log from "electron-log";
import { ChatStreamParams, ChatResponseEnd, Message } from "../ipc_types";
import { ToolRegistry } from "../../lib/tools";
import { getMaxTokens, getTemperature } from "../utils/token_utils";
import { getExtraProviderOptions } from "../utils/thinking_utils";

const logger = log.scope("chat_only_handlers");

// Active streams for cancellation
const activeStreams = new Map<number, AbortController>();

// In-memory ephemeral chat storage (incognito mode - no DB persistence)
const ephemeralChats = new Map<number, {
    id: number;
    title: string;
    messages: Message[];
    createdAt: Date;
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
        title: "New Chat",
        messages: [],
        createdAt: new Date(),
    });
    logger.log(`Created ephemeral chat: ${id}`);
    return id;
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
 * Handle chat-only stream request (ephemeral/incognito - no database)
 */
export async function handleChatOnlyStream(
    event: IpcMainInvokeEvent,
    req: ChatStreamParams,
    abortController: AbortController
): Promise<string> {
    logger.log("Starting ephemeral chat-only stream for chat:", req.chatId);

    try {
        const settings = await readSettings();

        // Get or create ephemeral chat
        let chat = ephemeralChats.get(req.chatId);
        if (!chat) {
            // Create new ephemeral chat if doesn't exist
            chat = {
                id: req.chatId,
                title: "New Chat",
                messages: [],
                createdAt: new Date(),
            };
            ephemeralChats.set(req.chatId, chat);
        }

        // Create user message (in-memory only)
        const userMessage: Message = {
            id: Date.now(), // Use timestamp as ID
            chatId: req.chatId,
            role: "user",
            content: req.prompt,
            createdAt: new Date(),
        };
        chat.messages.push(userMessage);

        // Set chat title from first message
        if (chat.messages.length === 1) {
            const words = req.prompt.split(' ').slice(0, 5).join(' ');
            chat.title = words.length > 30 ? words.substring(0, 30) + '...' : words;
            logger.info(`Set ephemeral chat ${req.chatId} title: "${chat.title}"`);
        }

        // Send initial messages to UI
        safeSend(event.sender, "chat:response:chunk", {
            chatId: req.chatId,
            messages: [...chat.messages],
        });

        // Get model client
        const { modelClient } = await getModelClient(
            settings.selectedModel,
            settings
        );

        // Get chat-only tools (5 core tools + workspace tools)
        const availableTools = ToolRegistry.getToolsForContext(false);
        logger.log(`Ephemeral chat-only mode: ${availableTools.length} tools available`);

        // Track sources from tool calls
        const collectedSources: any[] = [];

        // Convert tools to AI SDK format
        const tools: ToolSet = {};
        for (const tool of availableTools) {
            tools[tool.name] = {
                description: tool.description,
                parameters: tool.parameters,
                execute: async (params: any) => {
                    logger.log(`Executing tool: ${tool.name}`);
                    const result = await tool.handler({ ...params, chatId: req.chatId });

                    // If result has sources, collect them
                    if (result && typeof result === 'object' && result.sources) {
                        collectedSources.push(...result.sources);
                        // Return just the text for the AI
                        return result.text || result;
                    }

                    return result;
                },
            };
        }

        // Prepare message history
        const messageHistory = chat.messages.map((msg) => ({
            role: msg.role as "user" | "assistant" | "system",
            content: msg.content,
        }));

        // Stream response from AI
        let fullResponse = "";
        const result = streamText({
            model: modelClient.model,
            system: CHAT_ONLY_SYSTEM_PROMPT,
            messages: messageHistory,
            tools,
            temperature: 0.7, // Default conversational temperature
            abortSignal: abortController.signal,
            stopWhen: [stepCountIs(10)], // Allow up to 10 tool calls
            maxRetries: 2,
        });

        // Process stream
        for await (const chunk of result.textStream) {
            if (abortController.signal.aborted) {
                logger.log("Ephemeral chat-only stream aborted");
                break;
            }

            fullResponse += chunk;

            // Send chunk to UI (with temporary assistant message)
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

        // Create assistant message (in-memory only) WITH SOURCES
        logger.log(`📊 Collected ${collectedSources.length} sources from tool calls`);
        if (collectedSources.length > 0) {
            logger.log('📚 Sources:', collectedSources.map(s => s.title).join(', '));
        }

        const assistantMessage: Message = {
            id: Date.now() + 1,
            chatId: req.chatId,
            role: "assistant",
            content: fullResponse,
            sources: collectedSources.length > 0 ? collectedSources : undefined,
            createdAt: new Date(),
        };
        chat.messages.push(assistantMessage);

        // Send final chunk with sources included so UI receives them
        safeSend(event.sender, "chat:response:chunk", {
            chatId: req.chatId,
            messages: [...chat.messages],
        });

        // Send completion
        const endResponse: ChatResponseEnd = {
            chatId: req.chatId,
            messages: [...chat.messages],
        };
        safeSend(event.sender, "chat:response:end", endResponse);

        // Clean up
        activeStreams.delete(req.chatId);

        logger.log("Ephemeral chat-only stream completed successfully");
        return fullResponse;

    } catch (error) {
        logger.error("Error in ephemeral chat-only stream:", error);
        safeSend(event.sender, "chat:response:error", {
            chatId: req.chatId,
            error: `Sorry, there was an error: ${error}`,
        });
        activeStreams.delete(req.chatId);
        throw error;
    }
}

/**
 * Check if a chat is ephemeral (chat-only with no workspace)
 * Ephemeral chats have negative IDs
 */
export async function isChatOnly(chatId: number): Promise<boolean> {
    return isEphemeralChatId(chatId) || ephemeralChats.has(chatId);
}
