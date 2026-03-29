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
import {
    streamText,
    ToolSet,
    stepCountIs,
    jsonSchema as aiJsonSchema,
    NoOutputGeneratedError,
    NoContentGeneratedError,
} from "ai";
import { readSettings } from "../../main/settings";
import { getModelClient, getEffectiveModel } from "../utils/get_model_client";
import { safeSend } from "../utils/safe_sender";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import { ChatStreamParams, ChatResponseEnd, Message } from "../ipc_types";
import {
    AI_STREAM_EMPTY_RESPONSE_FALLBACK,
    AI_STREAMING_ERROR_MESSAGE_PREFIX,
} from "@/shared/texts";
import {
  getCompassUsageFromSupabase,
  recordCompassUsageTokens,
  totalTokensFromAiUsage,
} from "../../lib/auth/compass_usage";
import {
    compassExhaustedUserMessage,
    COMPASS_REACHABILITY_ERROR,
} from "../shared/compass_constants";
import { ToolRegistry } from "../../lib/tools";
import { getSessionMemory } from "../../lib/session-memory";

const logger = log.scope("chat_only_handlers");

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
        title: "New Chat",
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
        title: "New Chat",
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
export function addEphemeralMessage(chatId: number, message: { role: string; content: string }): void {
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

## Formatting Rules
- When you need to think through something, wrap it in <think>...</think> tags - this will be shown in a collapsible card
- DO NOT say things like "Let me search for that" or "I'll fetch that information" in your main response
- Keep your visible response clean and focused on the actual answer
- Tool calls happen automatically - you don't need to announce them

## Important
- Be helpful and conversational
- Use web_search for current events, news, documentation
- For building: always call create_workspace first
`;

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

        // Create user message (in-memory only) - store original for display
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

        // Log which model is being used (helps verify Auto vs single model)
        const effectiveModel = getEffectiveModel(settings);
        const sel = effectiveModel as { provider?: string; name?: string };
        if (sel?.provider === "auto") {
            const ids = settings.autoModelIds;
            logger.log(`Chat-only model: Auto (provider=${settings.autoProviderId ?? "default"}, models=${Array.isArray(ids) ? ids.join(", ") : "default chain"})`);
        } else {
            logger.log(`Chat-only model: ${sel?.provider ?? "?"}/${sel?.name ?? "?"}`);
        }

        // Get model client (uses Auto chain when autoModelRouting is ON)
        const { modelClient } = await getModelClient(
            effectiveModel,
            settings
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
                    logger.log(`Executing tool: ${tool.name}`);
                    const result = await tool.handler({ ...params, chatId: req.chatId });

                    if (
                        tool.name === "ask_user" &&
                        result &&
                        typeof result === "object" &&
                        (result as { __ask_user?: boolean }).__ask_user === true
                    ) {
                        const q = result as { question: string; options?: string[] };
                        const { waitForUserQuestionAnswer } = await import("./user_question_wait");
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
            };
        }

        // Merge global MCP tools (GitHub, etc.) with safe schema wrapping
        if (mcpTools && Object.keys(mcpTools).length > 0) {
            for (const [name, tool] of Object.entries(mcpTools)) {
                const t = tool as { description?: string; execute?: (...args: any[]) => any; inputSchema?: unknown };
                tools[name] = {
                    description: t.description,
                    inputSchema: PERMISSIVE_SCHEMA,
                    execute: t.execute,
                } as any;
            }
            logger.log(`Chat-only mode: +${Object.keys(mcpTools).length} MCP tools (total ${Object.keys(tools).length})`);
        }

        // Prepare message history
        const messageHistory = chat.messages.map((msg) => ({
            role: msg.role as "user" | "assistant" | "system",
            content: msg.content,
        }));

        // Get session memory for conversation continuity
        // For ephemeral workspace chats, use appId so memory persists across mode switches
        // For pure chat-only, use chatId
        const memoryKey = chat.appId ?? req.chatId;
        const sessionMemory = getSessionMemory(memoryKey);
        const sessionContext = sessionMemory.getContextForPrompt();
        let systemPrompt = CHAT_ONLY_SYSTEM_PROMPT;
        if (sessionContext) {
            systemPrompt += `\n\n${sessionContext}`;
            logger.log(`Injected session memory (${sessionMemory.getExchangeCount()} exchanges, ~${sessionMemory.estimateTokens()} tokens)`);
        }

        let fullResponse = "";
        const result = streamText({
            model: modelClient.model,
            system: systemPrompt,
            messages: messageHistory,
            tools,
            temperature: 0.7,
            abortSignal: abortController.signal,
            stopWhen: [stepCountIs(10)],
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

        void result.usage.catch((usageErr: unknown) => {
            if (
                NoOutputGeneratedError.isInstance(usageErr) ||
                NoContentGeneratedError.isInstance(usageErr)
            ) {
                return;
            }
            logger.warn("[chat-only] stream usage rejected:", usageErr);
        });

        // Process stream
        try {
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
        } catch (streamErr) {
            if (
                (NoOutputGeneratedError.isInstance(streamErr) ||
                    NoContentGeneratedError.isInstance(streamErr)) &&
                !abortController.signal.aborted
            ) {
                logger.warn("Chat-only stream: no usable text from model:", streamErr);
                if (!fullResponse.trim()) {
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
            } else {
                throw streamErr;
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
                    // Check if this tool exists in our tools object
                    const toolFn = tools[toolCall.toolName];
                    if (toolFn) {
                        logger.log(`[Chat-Only] Executing text-based tool: ${toolCall.toolName}`, toolCall.args);

                        // Execute the tool
                        const toolResult = await toolFn.execute?.({ ...toolCall.args, chatId: req.chatId }, {} as import("ai").ToolCallOptions);

                        // Append result to response
                        const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                        fullResponse += `\n\n<atlarix-tool-result tool="${toolCall.toolName}" status="complete">\n${resultStr}\n</atlarix-tool-result>\n`;
                        logger.log(`[Chat-Only] Text-tool executed: ${toolCall.toolName} ✓`);

                        // Collect sources if present
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

            // Update UI with tool results
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
        // ═══════════════════════════════════════════════════════════════

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

        // Record exchange in session memory for conversation continuity
        try {
            const cleanResponse = fullResponse
                .replace(/<[^>]*>/g, '')
                .replace(/```[\s\S]*?```/g, '[code]')
                .trim();
            sessionMemory.addExchange(req.prompt, cleanResponse);
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
        const noOutput =
            NoOutputGeneratedError.isInstance(error) ||
            NoContentGeneratedError.isInstance(error);
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
    }
}

/**
 * Check if a chat is ephemeral (chat-only with no workspace)
 * Ephemeral chats have negative IDs
 */
export async function isChatOnly(chatId: number): Promise<boolean> {
    return isEphemeralChatId(chatId) || ephemeralChats.has(chatId);
}
