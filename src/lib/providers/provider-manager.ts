/**
 * Atlarix Provider Manager
 * =======================
 * Unified interface for switching between AI providers
 */

import { BaseProvider, type ProviderType, type ProviderConfig } from "./base-provider";
import { OllamaProvider } from "./ollama-provider";
import { LMStudioProvider } from "./lmstudio-provider";
import { OpenRouterProvider } from "./openrouter-provider";

// ═══════════════════════════════════════════════════════════
// PROVIDER FACTORY
// ═══════════════════════════════════════════════════════════

export class ProviderManager {
    private currentProvider: BaseProvider | null = null;
    private config: ProviderConfig | null = null;

    /**
     * Create a provider instance based on config
     */
    createProvider(
        config: ProviderConfig,
        workspacePath: string | null = null,
        debug: boolean = false
    ): BaseProvider {
        this.config = config;

        switch (config.type) {
            case "ollama":
                this.currentProvider = new OllamaProvider(
                    workspacePath,
                    config.modelName,
                    debug,
                    config.host || "http://localhost:11434"
                );
                break;

            case "lmstudio":
                this.currentProvider = new LMStudioProvider(
                    workspacePath,
                    config.modelName,
                    debug,
                    config.host || "http://localhost:1234"
                );
                break;

            case "openrouter":
                if (!config.apiKey) {
                    throw new Error("OpenRouter requires API key");
                }
                this.currentProvider = new OpenRouterProvider(
                    workspacePath,
                    config.modelName,
                    debug,
                    config.apiKey
                );
                break;

            default:
                throw new Error(`Unknown provider type: ${config.type}`);
        }

        return this.currentProvider;
    }

    /**
     * Get current provider
     */
    getProvider(): BaseProvider | null {
        return this.currentProvider;
    }

    /** Alias for getProvider (used by chat-handler). */
    getCurrentProvider(): BaseProvider | null {
        return this.currentProvider;
    }

    /** Set current provider by id (used by chat-handler; requires config to be set separately). */
    setCurrentProvider(_providerId: string): void {
        // Provider is set via createProvider/switchProvider with full config
    }

    /** List available provider type ids (used by chat-handler). */
    getAvailableProviders(): string[] {
        return ["ollama", "lmstudio", "openrouter"];
    }

    /**
     * Switch to a different provider
     */
    switchProvider(
        newConfig: ProviderConfig,
        workspacePath: string | null = null,
        debug: boolean = false
    ): BaseProvider {
        return this.createProvider(newConfig, workspacePath, debug);
    }

    /**
     * Check if a provider is available
     */
    static async checkProviderAvailability(type: ProviderType, config?: Partial<ProviderConfig>): Promise<boolean> {
        try {
            switch (type) {
                case "ollama": {
                    const provider = new OllamaProvider(
                        null,
                        null,
                        false,
                        config?.host || "http://localhost:11434"
                    );
                    return await provider.isAvailable();
                }

                case "lmstudio": {
                    const provider = new LMStudioProvider(
                        null,
                        null,
                        false,
                        config?.host || "http://localhost:1234"
                    );
                    return await provider.isAvailable();
                }

                case "openrouter": {
                    if (!config?.apiKey) return false;
                    const provider = new OpenRouterProvider(null, null, false, config.apiKey);
                    return await provider.isAvailable();
                }

                default:
                    return false;
            }
        } catch {
            return false;
        }
    }

    /**
     * List available models for a provider
     */
    static async listProviderModels(type: ProviderType, config?: Partial<ProviderConfig>): Promise<string[]> {
        try {
            switch (type) {
                case "ollama": {
                    const provider = new OllamaProvider(null, null, false, config?.host);
                    return await provider.listModels();
                }

                case "lmstudio": {
                    const provider = new LMStudioProvider(null, null, false, config?.host);
                    return await provider.listModels();
                }

                case "openrouter": {
                    if (!config?.apiKey) return [];
                    const provider = new OpenRouterProvider(null, null, false, config.apiKey);
                    return await provider.listModels();
                }

                default:
                    return [];
            }
        } catch {
            return [];
        }
    }

    /**
     * Get recommended models for a provider
     */
    static getRecommendedModels(type: ProviderType): string[] {
        switch (type) {
            case "ollama":
                return (OllamaProvider as { getRecommendedModels?: () => string[] }).getRecommendedModels?.() ?? [];
            case "openrouter":
                return OpenRouterProvider.getToolCapableModels();
            case "lmstudio":
                return []; // LMStudio depends on what user has loaded
            default:
                return [];
        }
    }
}

// ═══════════════════════════════════════════════════════════
// CONVENIENCE FUNCTIONS
// ═════════════════════════════════════════════════════════ ══

/**
 * Auto-detect available providers
 */
export async function detectAvailableProviders(): Promise<ProviderType[]> {
    const available: ProviderType[] = [];

    // Check Ollama
    if (await ProviderManager.checkProviderAvailability("ollama")) {
        available.push("ollama");
    }

    // Check LMStudio
    if (await ProviderManager.checkProviderAvailability("lmstudio")) {
        available.push("lmstudio");
    }

    // Check OpenRouter (requires API key from env)
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey && await ProviderManager.checkProviderAvailability("openrouter", { apiKey })) {
        available.push("openrouter");
    }

    return available;
}

