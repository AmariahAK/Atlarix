/**
 * Chat Integration Handler
 * ========================
 * Connects UI to AI providers and tool execution
 */

import { ProviderManager } from '@/lib/providers/provider-manager';
import { ToolRegistry } from '@/lib/tools/registry';
import type { Message, ToolCall } from '@/types';

export class ChatHandler {
    private providerManager: ProviderManager;
    private currentMessages: Message[] = [];

    constructor() {
        this.providerManager = new ProviderManager();
    }

    /**
     * Send message and get AI response with tool execution
     */
    async sendMessage(
        userMessage: string,
        files?: File[],
        onMessageUpdate?: (message: Message) => void,
        onToolCall?: (toolCall: ToolCall) => void
    ): Promise<Message> {
        // Add user message to history
        const userMsg: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: userMessage,
            timestamp: new Date(),
        };

        this.currentMessages.push(userMsg);

        // Get current provider
        const provider = this.providerManager.getCurrentProvider();
        if (!provider) {
            throw new Error('No AI provider configured');
        }

        // Prepare context from files
        let context = userMessage;
        if (files && files.length > 0) {
            const fileContents = await Promise.all(
                files.map(async (file) => {
                    const text = await file.text();
                    return `\n\n--- ${file.name} ---\n${text}`;
                })
            );
            context = userMessage + fileContents.join('\n');
        }

        // Stream AI response
        const assistantMsg: Message = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: '',
            toolCalls: [],
            timestamp: new Date(),
        };

        try {
            const tools = ToolRegistry.toAISDKFormat();

            // BaseProvider.chat(userQuery: string) returns Promise<string>; this path expects a streaming API.
            // Cast to streaming shape for type-check; in practice use the provider's string API or a streaming adapter.
            type StreamingChat = (opts: {
                messages: { role: string; content: string }[];
                tools: unknown;
                temperature: number;
                maxTokens: number;
                stream: boolean;
            }) => AsyncIterable<{ type: string; text?: string; toolCallId?: string; toolName?: string; args?: unknown }>;
            const response = await (provider as unknown as { chat: StreamingChat }).chat({
                messages: [
                    {
                        role: 'system',
                        content: `You are Atlarix, an AI development partner with access to 41 powerful tools. You can read/write files, search the web, generate diagrams, run commands, and much more. Always use tools when appropriate to accomplish tasks efficiently.`,
                    },
                    ...this.currentMessages.map((msg) => ({
                        role: msg.role,
                        content: msg.content,
                    })),
                    {
                        role: 'user',
                        content: context,
                    },
                ],
                tools,
                temperature: 0.7,
                maxTokens: 4000,
                stream: true,
            });

            for await (const chunk of response) {
                if (chunk.type === 'text') {
                    assistantMsg.content += chunk.text ?? '';
                    onMessageUpdate?.(assistantMsg);
                } else if (chunk.type === 'tool-call') {
                    const toolCall: ToolCall = {
                        id: chunk.toolCallId ?? '',
                        name: chunk.toolName ?? '',
                        status: 'running',
                        params: (chunk.args ?? {}) as Record<string, any>,
                    };

                    assistantMsg.toolCalls = assistantMsg.toolCalls || [];
                    assistantMsg.toolCalls.push(toolCall);
                    onToolCall?.(toolCall);

                    try {
                        const result = await ToolRegistry.execute(chunk.toolName ?? '', chunk.args);
                        toolCall.status = (result as { success?: boolean }).success ? 'complete' : 'error';
                        toolCall.result = result as Record<string, any>;
                        onToolCall?.(toolCall);
                    } catch (error) {
                        toolCall.status = 'error';
                        toolCall.result = { error: String(error) };
                        onToolCall?.(toolCall);
                    }
                }
            }

            this.currentMessages.push(assistantMsg);
            return assistantMsg;
        } catch (error) {
            assistantMsg.content = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
            assistantMsg.toolCalls = [];
            this.currentMessages.push(assistantMsg);
            return assistantMsg;
        }
    }

    /**
     * Clear conversation history
     */
    clearHistory() {
        this.currentMessages = [];
    }

    /**
     * Get conversation history
     */
    getHistory(): Message[] {
        return [...this.currentMessages];
    }

    /**
     * Switch AI provider
     */
    async switchProvider(providerId: string) {
        await this.providerManager.setCurrentProvider(providerId);
    }

    /**
     * Get available providers
     */
    getProviders() {
        return this.providerManager.getAvailableProviders();
    }
}
