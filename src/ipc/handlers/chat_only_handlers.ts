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
import {
    compassExhaustedUserMessage,
    COMPASS_REACHABILITY_ERROR,
} from "../shared/compass_constants";
import { ToolRegistry } from "../../lib/tools";
import { getSessionMemory } from "../../lib/session-memory";
import { getToolActivityLabel } from "../../lib/tool-activity-labels";
import type { LargeLanguageModel } from "../../lib/schemas";
import { getExtraProviderOptions } from "../utils/thinking_utils";
import {
    buildReasoningProviderOptions,
    detectReasoningCapability,
    resolveReasoningCatalogModelId,
} from "@/lib/routing/reasoning-detector";
import {
    needsOpenRouterContextSafety,
    resolveContextBudgetTier,
} from "@/lib/routing/context_budget_routing";
import { escapeAtlarixTags } from "../utils/escape_atlarix_tags";

const logger = log.scope("chat_only_handlers");

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

/** System prompt for chat-only mode (no workspace) — includes runtime app version and NorahLabs identity */
function getChatOnlySystemPrompt(appVersion: string): string {
    return `You are the in-app assistant for **Atlarix**, the desktop AI coding copilot built by **NorahLabs** (norahlabs.com). Product site: atlarix.dev.

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

## Formatting rules
- Thinking: wrap in <redacted_thinking>...</redacted_thinking> when needed (collapsible in UI)
- Do not announce "let me search" — answer directly; tools run without narration
- Keep responses focused

## Important
- Be helpful and conversational. **RULE:** For one user question, pick **either** **web_search** **or** **deep_research**, never both in the same turn for overlapping topics. After **deep_research**, answer from its output only.
`;
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

        let gatedPrompt: string;
        try {
            gatedPrompt = prepareUserChatTurnInput(req.prompt);
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
            throw gateErr;
        }

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
            content: gatedPrompt,
            createdAt: new Date(),
        };
        chat.messages.push(userMessage);

        // Set chat title from first message
        if (chat.messages.length === 1) {
            const words = gatedPrompt.split(' ').slice(0, 5).join(' ');
            chat.title = words.length > 30 ? words.substring(0, 30) + '...' : words;
            logger.info(`Set ephemeral chat ${req.chatId} title: "${chat.title}"`);
        }

        // Send initial messages to UI
        safeSend(event.sender, "chat:response:chunk", {
            chatId: req.chatId,
            messages: [...chat.messages],
        });

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

        let contextBudgetTier = resolveContextBudgetTier(
            effectiveModel as LargeLanguageModel,
            settings,
        );
        if (req.forceThinkingTier === true) {
            contextBudgetTier = "thinking";
        }
        if (autoRoutedTierForTurn === "thinking") {
            contextBudgetTier = "thinking";
        }
        const thinkingTier = contextBudgetTier === "thinking";

        const chatOnlyProviderOptions: Record<string, unknown> = {
            "dyad-gateway": getExtraProviderOptions(
                modelClient.builtinProviderId,
                settings,
                thinkingTier,
            ),
        };
        if (needsOpenRouterContextSafety(modelClient.builtinProviderId, contextBudgetTier)) {
            chatOnlyProviderOptions.openrouter = {
                plugins: [{ id: "context-compression" }],
            };
        }
        if (thinkingTier) {
            const catalogModelId = resolveReasoningCatalogModelId(
                effectiveModel as LargeLanguageModel,
            );
            const cap = detectReasoningCapability(
                catalogModelId,
                modelClient.builtinProviderId,
            );
            const reasoningPatch = buildReasoningProviderOptions(cap, true);
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
                        toolName: getToolActivityLabel(tool.name),
                    });
                    try {
                    const paramsObj = params as Record<string, unknown>;

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
                    execute: t.execute,
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
        let systemPrompt = getChatOnlySystemPrompt(app.getVersion());
        if (sessionContext) {
            systemPrompt += `\n\n${sessionContext}`;
            logger.log(`Injected session memory (${sessionMemory.getExchangeCount()} exchanges, ~${sessionMemory.estimateTokens()} tokens)`);
        }

        let fullResponse = "";
        let chatOnlyStreamMessages: ModelMessage[] = messageHistory as ModelMessage[];
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
                const result = streamText({
                    model: modelClient.model,
                    system: systemPrompt,
                    messages: chatOnlyStreamMessages,
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
                            !["reasoning-delta", "reasoning-start"].includes(part.type)
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
                        lastContent: fullResponse,
                    }),
                },
            ];
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
        const { containsTextToolCall, parseTextToolCalls, stripToolCallXML } = await import("../utils/text_tool_parser");

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

        fullResponse = stripToolCallXML(fullResponse);
        fullResponse = sanitizeAssistantOutput(fullResponse);
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
            content: fullResponse,
            sources: uniqueCollectedSources.length > 0 ? uniqueCollectedSources : undefined,
            createdAt: new Date(),
            ...(autoRoutedTierForTurn != null && { autoRoutedTier: autoRoutedTierForTurn }),
        };
        chat.messages.push(assistantMessage);

        // Record exchange in session memory for conversation continuity
        try {
            const cleanResponse = fullResponse
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
    }
}

/**
 * Check if a chat is ephemeral (chat-only with no workspace)
 * Ephemeral chats have negative IDs
 */
export async function isChatOnly(chatId: number): Promise<boolean> {
    return isEphemeralChatId(chatId) || ephemeralChats.has(chatId);
}
