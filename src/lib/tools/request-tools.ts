/**
 * Request Tools - Meta-Tool for Dynamic Loading
 * ==============================================
 * Allows AI to request additional tool categories on demand
 */

import { ToolRegistry, ToolCategory } from "./registry";

// ============================================
// REQUEST TOOLS META-TOOL
// ============================================

/**
 * Request additional tool categories
 * This is a meta-tool that signals the system to load more tools
 */
ToolRegistry.register({
    name: "request_tools",
    category: ToolCategory.COMMAND,
    description: `Request additional tool categories when you need capabilities not yet available.
    
Use this when:
- Need memory/learning tools → request ["memory"]
- Need advanced editing → request ["refactoring"]  
- Need code analysis → request ["analysis"]
- Need testing capabilities → request ["testing"]
- Need execution/preview → request ["execution"]

Available categories:
- memory: recall_memory, save_learning, search_memory, export_memory
- refactoring: edit_file_section, apply_changes, refactor_code
- analysis: analyze_dependencies, diagnose_issue, health_check, get_change_impact
- testing: run_tests, test_changes, validate_code
- execution: live_preview, run_dev_server
- search_intelligence: semantic_search, find_related_code, build_knowledge_graph

CORE TOOLS ALREADY AVAILABLE (no request needed):
- Context: get_file_outline, view_symbol (10-40x more efficient than read_file)
- Surgical Edit: replace_code, insert_code, delete_lines (precise changes)
- Files: read_file, write_file, list_files, search_code
- Commands: run_command, add_dependency

DO NOT request categories you don't immediately need. Use core tools first!`,
    cost: 0, // Free meta-tool
    requiresWorkspace: false, // Available in both modes (but only useful with workspace)
    isCore: true, // Always available
    parameters: {
        categories: {
            type: "array",
            items: { type: "string" },
            description: "Tool category names to load (e.g., ['memory', 'analysis'])",
            required: true,
        },
        reason: {
            type: "string",
            description: "Why you need these tools (helps system optimize)",
            required: false,
        },
    },
    handler: async (params: { categories: string[]; reason?: string }) => {
        // This is handled by the chat agent, not executed directly
        // Return a special signal that the agent will intercept
        return {
            __REQUEST_TOOLS__: true,
            categories: params.categories,
            reason: params.reason,
            message: `Requested tool categories: ${params.categories.join(", ")}`,
        };
    },
});
