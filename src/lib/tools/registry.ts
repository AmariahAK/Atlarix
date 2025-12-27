/**
 * Atlarix Tool Registry
 * ====================
 * Central registry for all available tools
 */

import type { Tool } from "../providers/base-provider";

// ═══════════════════════════════════════════════════════════
// TOOL CATEGORIES & COSTS
// ═══════════════════════════════════════════════════════════

export enum ToolCategory {
    // NO WORKSPACE NEEDED
    DATETIME = "datetime",
    WEB = "web",

    // WORKSPACE REQUIRED - CORE (shown by default)
    FILE = "file",
    FILE_ADVANCED = "file_advanced",
    CODE = "code",
    SEARCH = "search",
    DIAGRAM = "diagram",
    GIT = "git",
    COMMAND = "command",
    TASK = "task",

    // WORKSPACE REQUIRED - OPTIONAL (loaded on demand)
    MEMORY = "memory",
    SEARCH_INTELLIGENCE = "search_intelligence",
    EXECUTION = "execution",
    ANALYSIS = "analysis",
    REFACTORING = "refactoring",
    TESTING = "testing",
}

export interface ToolMetadata {
    name: string;
    description: string;
    category: ToolCategory;
    cost: number; // Credits
    parameters: any;
    handler: (args: any) => Promise<any>;
    requiresWorkspace?: boolean; // True if tool needs a workspace to function
    isCore?: boolean; // True if tool should be shown by default (with workspace)
    isReadOnly?: boolean; // True if tool only reads data (safe for Ask mode)
}

// ═══════════════════════════════════════════════════════════
// TOOL REGISTRY
// ═══════════════════════════════════════════════════════════

export class ToolRegistry {
    private static tools: Map<string, ToolMetadata> = new Map();

    /**
     * Register a tool
     */
    static register(metadata: ToolMetadata): void {
        this.tools.set(metadata.name, metadata);
    }

    /**
     * Get a tool by name
     */
    static get(name: string): ToolMetadata | undefined {
        return this.tools.get(name);
    }

    /**
     * Get all tools
     */
    static getAll(): ToolMetadata[] {
        return Array.from(this.tools.values());
    }

    /**
     * Get tools by category
     */
    static getByCategory(category: ToolCategory): ToolMetadata[] {
        return this.getAll().filter((tool) => tool.category === category);
    }

    /**
     * Get tools filtered by workspace context
     * @param hasWorkspace - Whether a workspace is active
     * @returns Appropriate tools for the context
     */
    static getToolsForContext(hasWorkspace: boolean): ToolMetadata[] {
        if (!hasWorkspace) {
            // Chat-only mode: only tools that don't require workspace
            return this.getAll().filter(
                (tool) => !tool.requiresWorkspace
            );
        } else {
            // Workspace mode: 
            // - All core workspace tools
            // - Plus chat-only tools (web, datetime - they work in both modes)
            return this.getAll().filter(
                (tool) =>
                    (tool.requiresWorkspace && tool.isCore) || // Core workspace tools
                    (!tool.requiresWorkspace && tool.isCore)    // Chat-only tools (available everywhere)
            );
        }
    }

    /**
     * Get tools for Ask mode (read-only tools only)
     * Includes: read_file, list_files, search_code, web_search, get_diagram, git_log, etc.
     * Excludes: write_file, delete_file, run_command, code generation tools
     * @returns Read-only tools safe for Ask mode
     */
    static getToolsForAskMode(): ToolMetadata[] {
        return this.getAll().filter(
            (tool) => tool.isReadOnly === true
        );
    }

    /**
     * Get all optional workspace tools (for dynamic loading)
     * @returns Tools that can be requested via request_tools
     */
    static getOptionalWorkspaceTools(): ToolMetadata[] {
        return this.getAll().filter(
            (tool) => tool.requiresWorkspace && !tool.isCore
        );
    }

    /**
     * Get tools by categories (for request_tools dynamic loading)
     * @param categories - Array of category names to load
     * @returns Tools matching the requested categories
     */
    static getToolsByCategories(categories: ToolCategory[]): ToolMetadata[] {
        return this.getAll().filter(
            (tool) => categories.includes(tool.category)
        );
    }

    /**
     * Convert to AI SDK format
     */
    static toAISDKFormat(): Tool[] {
        return this.getAll().map((tool) => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
    }

    /**
     * Convert filtered tools to AI SDK format
     * @param hasWorkspace - Whether a workspace is active
     */
    static toAISDKFormatForContext(hasWorkspace: boolean): Tool[] {
        return this.getToolsForContext(hasWorkspace).map((tool) => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
    }

    /**
     * Execute a tool
     */
    static async execute(name: string, args: any): Promise<any> {
        const tool = this.get(name);
        if (!tool) {
            throw new Error(`Tool not found: ${name}`);
        }

        try {
            const result = await tool.handler(args);
            return {
                success: true,
                result,
                cost: tool.cost,
            };
        } catch (error) {
            return {
                success: false,
                error: String(error),
                cost: 0,
            };
        }
    }

    /**
     * Clear all tools (for testing)
     */
    static clear(): void {
        this.tools.clear();
    }
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Create parameter schema for a tool
 */
export function createParameters(properties: Record<string, any>, required: string[] = []): any {
    return {
        type: "object",
        properties,
        required,
    };
}

/**
 * Create a simple string parameter
 */
export function stringParam(description: string): any {
    return {
        type: "string",
        description,
    };
}

/**
 * Create an array parameter
 */
export function arrayParam(itemType: string, description: string): any {
    return {
        type: "array",
        items: { type: itemType },
        description,
    };
}

/**
 * Create a boolean parameter
 */
export function booleanParam(description: string): any {
    return {
        type: "boolean",
        description,
    };
}
