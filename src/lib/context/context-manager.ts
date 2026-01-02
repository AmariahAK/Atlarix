/**
 * Atlarix Context Manager
 * =======================
 * Model-aware token budget management for smart context slicing.
 * 
 * Ensures AI tools stay within token limits based on the active model.
 */

// Model context sizes (in tokens)
const MODEL_CONTEXT_SIZES: Record<string, number> = {
    // Ollama (local - typically 8K)
    'ollama': 8192,
    'llama': 8192,
    'mistral': 8192,
    'codellama': 8192,
    'deepseek-coder': 16384,

    // LMStudio (local - typically 16K)
    'lmstudio': 16384,

    // MiniMax
    'minimax': 16384,
    'abab6.5s-chat': 16384,

    // OpenRouter / Cloud models
    'gpt-4': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4o': 128000,
    'gpt-3.5-turbo': 16384,
    'claude-3': 200000,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,
    'claude-3.5-sonnet': 200000,
    'claude-sonnet-4': 200000,
    'gemini-pro': 32768,
    'gemini-1.5': 1000000,

    // Default fallback
    'default': 16384,
};

// Base token usage (system prompt + context + tools)
const BASE_TOKEN_USAGE = {
    systemPrompt: 2000,
    workspaceContext: 3000,
    sessionMemory: 2000,
    toolDefinitions: 4000,
    diagram: 1000,
    diagramPrevious: 1000, // If comparing
    userMessage: 500,
};

export interface TokenBudget {
    fileRead: number;
    commandOutput: number;
    search: number;
    outline: number;
    symbol: number;
}

export interface ContextManagerOptions {
    modelId?: string;
    providerId?: string;
    hasDiagramComparison?: boolean;
}

export class ContextManager {
    private modelContextSize: number;
    private baseUsage: number;

    constructor(options: ContextManagerOptions = {}) {
        this.modelContextSize = this.detectContextSize(options.modelId, options.providerId);
        this.baseUsage = this.calculateBaseUsage(options.hasDiagramComparison ?? false);
    }

    /**
     * Detect context size based on model/provider
     */
    private detectContextSize(modelId?: string, providerId?: string): number {
        // Try exact model match first
        if (modelId) {
            const modelLower = modelId.toLowerCase();
            for (const [key, size] of Object.entries(MODEL_CONTEXT_SIZES)) {
                if (modelLower.includes(key)) {
                    return size;
                }
            }
        }

        // Try provider match
        if (providerId) {
            const providerLower = providerId.toLowerCase();
            if (providerLower.includes('ollama')) return 8192;
            if (providerLower.includes('lmstudio')) return 16384;
            if (providerLower.includes('openrouter')) return 128000; // Assume large
        }

        return MODEL_CONTEXT_SIZES['default'];
    }

    /**
     * Calculate base token usage
     */
    private calculateBaseUsage(hasDiagramComparison: boolean): number {
        let usage = BASE_TOKEN_USAGE.systemPrompt +
            BASE_TOKEN_USAGE.workspaceContext +
            BASE_TOKEN_USAGE.sessionMemory +
            BASE_TOKEN_USAGE.toolDefinitions +
            BASE_TOKEN_USAGE.diagram +
            BASE_TOKEN_USAGE.userMessage;

        if (hasDiagramComparison) {
            usage += BASE_TOKEN_USAGE.diagramPrevious;
        }

        return usage;
    }

    /**
     * Get available tokens after base usage
     */
    getAvailableTokens(): number {
        // Reserve 20% for AI response
        const responseReserve = Math.floor(this.modelContextSize * 0.2);
        return this.modelContextSize - this.baseUsage - responseReserve;
    }

    /**
     * Get token budget for specific operation type
     */
    getBudget(): TokenBudget {
        const available = this.getAvailableTokens();

        // Ultra-conservative for small models (Ollama 8K)
        if (this.modelContextSize <= 8192) {
            return {
                fileRead: 300,
                commandOutput: 500,
                search: 200,
                outline: 150,
                symbol: 100,
            };
        }

        // Conservative for medium models (LMStudio 16K, MiniMax)
        if (this.modelContextSize <= 16384) {
            return {
                fileRead: 800,
                commandOutput: 1500,
                search: 500,
                outline: 300,
                symbol: 200,
            };
        }

        // Generous for large models (GPT-4 128K)
        if (this.modelContextSize <= 128000) {
            return {
                fileRead: 3000,
                commandOutput: 5000,
                search: 2000,
                outline: 1000,
                symbol: 500,
            };
        }

        // Very generous for huge models (Claude 200K, Gemini 1M)
        return {
            fileRead: 5000,
            commandOutput: 10000,
            search: 5000,
            outline: 2000,
            symbol: 1000,
        };
    }

    /**
     * Get max lines for file reading based on budget
     * Assumes ~10 tokens per line average
     */
    getMaxLines(): number {
        const budget = this.getBudget();
        return Math.floor(budget.fileRead / 10);
    }

    /**
     * Get max search results based on budget
     * Assumes ~50 tokens per result with context
     */
    getMaxSearchResults(): number {
        const budget = this.getBudget();
        return Math.floor(budget.search / 50);
    }

    /**
     * Check if model is a "small" model requiring aggressive slicing
     */
    isSmallModel(): boolean {
        return this.modelContextSize <= 8192;
    }

    /**
     * Check if model is a "large" model where we can be generous
     */
    isLargeModel(): boolean {
        return this.modelContextSize >= 128000;
    }

    /**
     * Get summary for logging
     */
    getSummary(): string {
        const budget = this.getBudget();
        return `ContextManager: ${this.modelContextSize} tokens total, ${this.getAvailableTokens()} available. ` +
            `Budgets: file=${budget.fileRead}, cmd=${budget.commandOutput}, search=${budget.search}`;
    }
}

// Singleton for current session
let currentContextManager: ContextManager | null = null;

export function getContextManager(options?: ContextManagerOptions): ContextManager {
    if (!currentContextManager || options) {
        currentContextManager = new ContextManager(options);
    }
    return currentContextManager;
}

export function resetContextManager(): void {
    currentContextManager = null;
}
