/**
 * Atlarix Ollama Provider
 * ======================
 * Local AI provider using Ollama
 * Port from StackSense ollama_agent.py + Atlarix ollama_provider.ts
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { BaseProvider, type Tool, type ToolResult } from "./base-provider";

// ═══════════════════════════════════════════════════════════
// OLLAMA PROVIDER
// ═══════════════════════════════════════════════════════════

export class OllamaProvider extends BaseProvider {
    private host: string;
    private provider: ReturnType<typeof createOpenAICompatible>;

    constructor(
        workspacePath: string | null = null,
        modelName: string | null = null,
        debug: boolean = false,
        host: string = "http://localhost:11434"
    ) {
        super(workspacePath, modelName || "llama3.2:latest", debug);
        this.host = this._parseHost(host);

        // Create OpenAI-compatible provider
        this.provider = createOpenAICompatible({
            name: "ollama",
            baseURL: `${this.host}/v1`,
            headers: {},
        });

        if (this.debug) {
            console.log(`[Ollama] Connecting to ${this.host}`);
            console.log(`[Ollama] Using model: ${this.modelName}`);
        }
    }

    private _parseHost(host: string): string {
        if (!host) return "http://localhost:11434";

        // Add protocol if missing
        if (!host.startsWith("http://") && !host.startsWith("https://")) {
            // Check for IPv6
            if (host.includes("::") || (host.match(/:/g) || []).length > 1) {
                return host.startsWith("[")
                    ? `http://${host}`
                    : `http://[${host}]:11434`;
            }

            // Check for host:port format
            if (host.includes(":")) {
                return `http://${host}`;
            }

            // Just hostname
            return `http://${host}:11434`;
        }

        return host;
    }

    getProviderName(): string {
        return "ollama";
    }

    getModelDisplayName(): string {
        return `Ollama: ${this.modelName}`;
    }

    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch(`${this.host}/api/tags`, {
                signal: AbortSignal.timeout(2000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.host}/api/tags`);

            if (!response.ok) {
                throw new Error(`Failed to list models: ${response.status}`);
            }

            const data = await response.json();
            const models = data.models || [];

            return models.map((m: any) => m.name);
        } catch (error) {
            if (this.debug) {
                console.error("[Ollama] Error listing models:", error);
            }
            throw new Error(
                `Cannot connect to Ollama at ${this.host}. Make sure Ollama is running.`
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
                console.log(`[Ollama] Iteration ${iteration + 1}`);
            }

            try {
                // Create model instance
                const model = this.provider(this.modelName);

                // Call with streaming (using ai SDK's streamText)
                const { streamText } = await import("ai");

                const result = await streamText({
                    model,
                    messages,
                    tools: tools.length > 0 ? this._convertToAISDKTools(tools) : undefined,
                    onChunk: (payload) => {
                        const c = (payload as { chunk?: { type?: string; text?: string; delta?: string } }).chunk;
                        if (c?.type === "text-delta" && onToken) {
                            const text = c.text ?? c.delta ?? "";
                            onToken(text);
                            fullResponse += text;
                        }
                    },
                });

                // Wait for completion
                const finalResult = await result.text;

                const rawCalls = result.toolCalls;
                const toolCalls = Array.isArray(rawCalls) ? rawCalls : await (rawCalls as Promise<unknown[]>).catch(() => []);

                if (toolCalls.length === 0) {
                    // No tool calls, return response
                    fullResponse += finalResult;
                    break;
                }

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

                    messages.push({
                        role: "assistant" as const,
                        content: finalResult,
                    } as unknown as (typeof messages)[0]);

                    messages.push({
                        role: "tool" as const,
                        content: toolResult.success
                            ? toolResult.result
                            : `Error: ${toolResult.error}`,
                    } as unknown as (typeof messages)[0]);
                }

            } catch (error) {
                if (this.debug) {
                    console.error("[Ollama] Error:", error);
                }
                fullResponse = `Error communicating with Ollama: ${error}`;
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

export async function checkOllamaRunning(host?: string): Promise<boolean> {
    const provider = new OllamaProvider(null, null, false, host);
    return provider.isAvailable();
}

export async function listOllamaModels(host?: string): Promise<string[]> {
    try {
        const provider = new OllamaProvider(null, null, false, host);
        return await provider.listModels();
    } catch {
        return [];
    }
}
