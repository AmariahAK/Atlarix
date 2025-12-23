/**
 * Atlarix LMStudio Provider
 * ========================
 * Local AI provider using LMStudio
 * Port from StackSense lmstudio_agent.py
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { BaseProvider, type Tool, type ToolResult } from "./base-provider";

// ═══════════════════════════════════════════════════════════
// LMSTUDIO PROVIDER
// ═══════════════════════════════════════════════════════════

export class LMStudioProvider extends BaseProvider {
    private host: string;
    private client: ReturnType<typeof createOpenAI>;

    constructor(
        workspacePath: string | null = null,
        modelName: string | null = null,
        debug: boolean = false,
        host: string = "http://localhost:1234"
    ) {
        super(workspacePath, modelName || "local-model", debug);
        this.host = host;

        // Create OpenAI-compatible client for LMStudio
        this.client = createOpenAI({
            baseURL: `${this.host}/v1`,
            apiKey: "lm-studio", // LMStudio doesn't require real key
        });

        if (this.debug) {
            console.log(`[LMStudio] Connecting to ${this.host}`);
            console.log(`[LMStudio] Using model: ${this.modelName}`);
        }
    }

    getProviderName(): string {
        return "lmstudio";
    }

    getModelDisplayName(): string {
        return `LMStudio: ${this.modelName}`;
    }

    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch(`${this.host}/v1/models`, {
                signal: AbortSignal.timeout(2000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.host}/v1/models`);

            if (!response.ok) {
                throw new Error(`Failed to list models: ${response.status}`);
            }

            const data = await response.json();
            const models = data.data || [];

            // Filter to only LLM models (not embeddings)
            const llmModels = models.filter(
                (m: any) => m.type === "llm" || !("type" in m)
            );

            return llmModels.map((m: any) => m.id);
        } catch (error) {
            if (this.debug) {
                console.error("[LMStudio] Error listing models:", error);
            }
            throw new Error(
                `Cannot connect to LMStudio at ${this.host}. Make sure LMStudio's local server is running.`
            );
        }
    }

    async chat(
        userQuery: string,
        onToken?: (token: string) => void,
        onToolStart?: (toolName: string) => void,
        onToolComplete?: (toolName: string, status: string) => void
    ): Promise<string> {
        const start = Date.now();
        this.stats = { toolsUsed: 0, totalTime: 0 };

        // Build messages
        const messages = [
            { role: "system" as const, content: this._loadSystemPrompt() },
            { role: "user" as const, content: userQuery },
        ];

        const tools = this.getAvailableTools();

        let fullResponse = "";
        const maxIterations = 10; // Prevent infinite loops

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            if (this.debug) {
                console.log(`[LMStudio] Iteration ${iteration + 1}`);
            }

            try {
                // Create model instance
                const model = this.client(this.modelName);

                // Call with streaming (using ai SDK's streamText)
                const { streamText } = await import("ai");

                const result = await streamText({
                    model,
                    messages,
                    tools: tools.length > 0 ? this._convertToAISDKTools(tools) : undefined,
                    onChunk: (chunk) => {
                        if (chunk.type === "text-delta" && onToken) {
                            onToken(chunk.textDelta);
                            fullResponse += chunk.textDelta;
                        }
                    },
                });

                // Wait for completion
                const finalResult = await result.text;

                // Check for tool calls
                const toolCalls = result.toolCalls || [];

                if (toolCalls.length === 0) {
                    // No tool calls, return response
                    fullResponse += finalResult;
                    break;
                }

                // Execute tool calls
                for (const toolCall of toolCalls) {
                    const toolName = toolCall.toolName;
                    const toolArgs = toolCall.args;

                    if (onToolStart) {
                        onToolStart(toolName);
                    }

                    const toolResult = await this._executeTool(toolName, toolArgs);
                    this.stats.toolsUsed++;

                    if (onToolComplete) {
                        const status = toolResult.success ? "✓" : "✗";
                        onToolComplete(toolName, `${status} ${toolResult.elapsed.toFixed(1)}s`);
                    }

                    // Check for permission required
                    if (toolResult.result?.includes("__PERMISSION_REQUIRED__")) {
                        return toolResult.result.replace("__PERMISSION_REQUIRED__\n", "");
                    }

                    // Add tool result to messages
                    messages.push({
                        role: "assistant" as const,
                        content: finalResult,
                    });

                    messages.push({
                        role: "tool" as const,
                        content: toolResult.success
                            ? toolResult.result
                            : `Error: ${toolResult.error}`,
                    });
                }

                // Continue loop to let model process tool results
            } catch (error) {
                if (this.debug) {
                    console.error("[LMStudio] Error:", error);
                }

                // Check if it's a tool calling not supported error
                if (error && typeof error === 'object' && 'message' in error) {
                    const msg = String(error.message).toLowerCase();
                    if (msg.includes("tool") || msg.includes("function")) {
                        fullResponse = "Tool calling not supported by this model. Please use a different model or provider.";
                        break;
                    }
                }

                fullResponse = `Error communicating with LMStudio: ${error}`;
                break;
            }
        }

        this.stats.totalTime = (Date.now() - start) / 1000;
        return fullResponse;
    }

    private _convertToAISDKTools(tools: Tool[]): Record<string, any> {
        const converted: Record<string, any> = {};

        for (const tool of tools) {
            converted[tool.function.name] = {
                description: tool.function.description,
                parameters: tool.function.parameters,
            };
        }

        return converted;
    }
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

export async function checkLMStudioRunning(host?: string): Promise<boolean> {
    const provider = new LMStudioProvider(null, null, false, host);
    return provider.isAvailable();
}

export async function listLMStudioModels(host?: string): Promise<string[]> {
    try {
        const provider = new LMStudioProvider(null, null, false, host);
        return await provider.listModels();
    } catch {
        return [];
    }
}
