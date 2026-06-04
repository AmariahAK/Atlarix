/**
 * Atlarix OpenRouter Provider
 * ==========================
 * Cloud AI provider with access to 100+ models
 * Port from StackSense openrouter_agent.py
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { OPENROUTER_APP_HEADERS } from "@/ipc/shared/openrouter_app_headers";
import { BaseProvider, type Tool } from "./base-provider";

// ═══════════════════════════════════════════════════════════
// OPENROUTER PROVIDER
// ═══════════════════════════════════════════════════════════

export class OpenRouterProvider extends BaseProvider {
    private apiKey: string;
    private provider: ReturnType<typeof createOpenRouter>;

    // Default free model (supports tool calling)
    private static DEFAULT_MODEL = "nvidia/nemotron-nano-9b-v2:free";

    // Recommended tool-capable models
    private static TOOL_CAPABLE_MODELS = [
        "nvidia/nemotron-nano-9b-v2:free",
        "mistralai/devstral-2512:free",
        "amazon/nova-2-lite-v1:free",
        "arcee-ai/trinity-mini:free",
        "openai/gpt-4o-mini", // Paid but reliable
    ];

    constructor(
        workspacePath: string | null = null,
        modelName: string | null = null,
        debug: boolean = false,
        apiKey: string = ""
    ) {
        super(workspacePath, modelName || OpenRouterProvider.DEFAULT_MODEL, debug);

        this.apiKey = apiKey || process.env.OPENROUTER_API_KEY || "";

        if (!this.apiKey) {
            throw new Error(
                "OpenRouter API key required. Set OPENROUTER_API_KEY environment variable or pass apiKey parameter."
            );
        }

        // Create OpenRouter provider
        this.provider = createOpenRouter({
            apiKey: this.apiKey,
            headers: { ...OPENROUTER_APP_HEADERS },
        });

        if (this.debug) {
            console.log(`[OpenRouter] Using model: ${this.modelName}`);
        }
    }

    getProviderName(): string {
        return "openrouter";
    }

    getModelDisplayName(): string {
        return `OpenRouter: ${this.modelName}`;
    }

    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch("https://openrouter.ai/api/v1/models", {
                headers: {
                    ...OPENROUTER_APP_HEADERS,
                    Authorization: `Bearer ${this.apiKey}`,
                },
                signal: AbortSignal.timeout(5000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await fetch("https://openrouter.ai/api/v1/models", {
                headers: {
                    ...OPENROUTER_APP_HEADERS,
                    Authorization: `Bearer ${this.apiKey}`,
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to list models: ${response.status}`);
            }

            const data = await response.json();
            const models = data.data || [];

            // Filter to tool-capable models
            const toolCapableModels = models
                .filter((m: any) => {
                    const supportedParams = m.supported_parameters || [];
                    return supportedParams.includes("tools");
                })
                .map((m: any) => m.id);

            return toolCapableModels;
        } catch (error) {
            if (this.debug) {
                console.error("[OpenRouter] Error listing models:", error);
            }
            throw new Error("Cannot connect to OpenRouter. Check your API key and internet connection.");
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
        let iteration = 0;
        while (true) {
            iteration++;
            if (this.debug) {
                console.log(`[OpenRouter] Iteration ${iteration}`);
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

                const finalResult = await result.text;

                const rawCalls = result.toolCalls;
                const toolCalls = Array.isArray(rawCalls) ? rawCalls : await (rawCalls as Promise<unknown[]>).catch(() => []);

                if (toolCalls.length === 0) {
                    // Check for text-based permission request (fallback)
                    const content = finalResult.toLowerCase();
                    const permissionKeywords = [
                        "may i create",
                        "can i create",
                        "shall i create",
                        "may i run",
                        "should i proceed with",
                    ];

                    const isPermissionRequest =
                        content.includes("?") &&
                        content.length < 400 &&
                        permissionKeywords.some((k) => content.includes(k));

                    if (isPermissionRequest) {
                        return `__PERMISSION_REQUIRED__\n🔔 ${finalResult}\n[yes] / [no]`;
                    }

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
                    console.error("[OpenRouter] Error:", error);
                }
                fullResponse = `Error communicating with OpenRouter: ${error}`;
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

    static getToolCapableModels(): string[] {
        return OpenRouterProvider.TOOL_CAPABLE_MODELS;
    }

    static getDefaultModel(): string {
        return OpenRouterProvider.DEFAULT_MODEL;
    }
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

