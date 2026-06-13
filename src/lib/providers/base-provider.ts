/**
 * Atlarix Base Provider
 * ====================
 * Base interface and utilities for AI providers (Ollama, LMStudio, OpenRouter)
 *  
 * Port from StackSense base_agent.py
 */


// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export interface Tool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, any>;
            required?: string[];
        };
    };
}

export interface ToolResult {
    success: boolean;
    result: string;
    error?: string;
    elapsed: number;
}

export interface AgentStats {
    toolsUsed: number;
    totalTime: number;
}

// ═══════════════════════════════════════════════════════════
// BASE PROVIDER CLASS
// ═══════════════════════════════════════════════════════════

export abstract class BaseProvider {
    protected workspacePath: string | null;
    protected modelName: string;
    protected debug: boolean;
    protected maxTools: number = 50;
    protected stats: AgentStats = { toolsUsed: 0, totalTime: 0 };

    constructor(
        workspacePath: string | null = null,
        modelName: string = "default",
        debug: boolean = false
    ) {
        this.workspacePath = workspacePath;
        this.modelName = modelName;
        this.debug = debug;
    }

    /**
     * Get provider name (ollama, lmstudio, openrouter)
     */
    abstract getProviderName(): string;

    /**
     * Get model display name
     */
    abstract getModelDisplayName(): string;

    /**
     * Main chat interface
     */
    abstract chat(
        userQuery: string,
        onToken?: (token: string) => void,
        onToolStart?: (toolName: string) => void,
        onToolComplete?: (toolName: string, status: string) => void
    ): Promise<string>;

    /**
     * List available models
     */
    abstract listModels(): Promise<string[]>;

    /**
     * Check if provider is available/running
     */
    abstract isAvailable(): Promise<boolean>;

    /**
     * Get available tools
     */
    getAvailableTools(): Tool[] {
        // Import and initialize tools
        const { ToolRegistry } = require("../tools");
        return ToolRegistry.toAISDKFormat();
    }

    /**
     * Execute a tool
     */
    protected async _executeTool(
        toolName: string,
        toolArgs: Record<string, any>
    ): Promise<ToolResult> {
        const start = Date.now();

        try {
            // Import ToolRegistry
            const { ToolRegistry } = require("../tools");

            const result = await ToolRegistry.execute(toolName, toolArgs);

            return {
                success: result.success,
                result: result.result || result.error || "Tool executed",
                error: result.error,
                elapsed: (Date.now() - start) / 1000,
            };
        } catch (error) {
            return {
                success: false,
                result: "",
                error: String(error),
                elapsed: (Date.now() - start) / 1000,
            };
        }
    }

    /**
     * Load the StackSense system prompt
     */
    protected _loadSystemPrompt(): string {
        return `You are an AI agent running inside Atlarix, the open-weight frontier harness.

You help developers build, understand, and modify projects collaboratively.

## CRITICAL RULES

1. **Tools First**: Always call tools before responding about code/files
2. **Never Hallucinate**: Don't guess file contents - read them
3. **Request Permission**: Changed are previewed before applying
4. **Work in Chunks**: Break tasks into small, testable pieces
5. **Use Memory**: Recall what you've learned about the codebase

## CORE WORKFLOWS

### File Creation
When user asks to CREATE a file:
1. Call write_file() immediately
2. Tool will show permission dialog
3. User approves → file created

### Code Exploration
1. Call get_project_structure() to see layout
2. Call read_file() to read specific files
3. Call search_code() to find patterns

### Debugging
1. Call analyze_stack_trace() for errors
2. Call search_code() to find relevant code
3. Call write_file() to fix issues

You have access to 25+ tools for file operations, code generation, web search, memory, and more. Use them!`;
    }

    /**
     * Get stats
     */
    getStats(): AgentStats {
        return this.stats;
    }
}

// ═══════════════════════════════════════════════════════════
// PROVIDER TYPES
// ═══════════════════════════════════════════════════════════

export type ProviderType = "ollama" | "lmstudio" | "openrouter";

export interface ProviderConfig {
    type: ProviderType;
    modelName?: string;
    host?: string; // For Ollama/LMStudio
    apiKey?: string; // For OpenRouter
}
