/**
 * Atlarix Tools Index
 * ==================
 * Central export for all tools
 * 
 * Import this file to register all tools automatically
 */

// Registry
export * from "./registry";

// Tool modules (importing registers them)
import "./file-tools";
import "./advanced-file-tools";
import "./edit-tools"; // Surgical edit tools: replace_code, insert_code, delete_lines
import "./symbol-tools"; // Symbol tools: get_file_outline, view_symbol
import "./web-tools";
import "./execution-tools";
import "./memory-tools";
import "./search-intelligence-tools";
import "./template-tools";
import "./ai-template-tools";
import "./workspace-tools";
import "./request-tools";
import "./git-tools";
import "./analysis-tools";
import "./diagram-tools";
import "./blueprint-tools"; // Phase 7 Additive Blueprint
import "./project-memory-tools"; // v5.0 Section 2
import "./atlarix-ignore-tools";
import "./testing-tools";
import "./refactoring-tools";
import "./project-structure-tools"; // Multi-Layer Fallback System
import "./meta-tools"; // Phase 3: New meta-tools
import "./agent-tools"; // v2.1: delegate_to_agent
import "./mode-tools"; // request_mode_change (Ask/Build/Auto)
import "./reference-project-tools"; // v3.6 add_reference_project
import "./db-tools"; // v3.6 DB Extension: db_query, db_schema, db_list, db_mutate
import "./stream-tools"; // v3.9 stream_terminal_output, stream_pipeline_logs
import "./workforce-tools"; // v4.0 Slack, Jira, Linear, Sentry, Calendar, CI

// Re-export registry for convenience
import { ToolRegistry } from "./registry";
export { ToolRegistry };

/**
 * Initialize all tools
 * Call this once at app startup
 */
export function initializeTools(): void {
    // Tools are auto-registered on import
    // This function exists for explicit initialization if needed
    const toolCount = ToolRegistry.getAll().length;
    console.log(`[Atlarix] Initialized ${toolCount} tools`);
}

/**
 * Get tool statistics
 */
export function getToolStats() {
    const all = ToolRegistry.getAll();

    const byCategory = all.reduce((acc, tool) => {
        acc[tool.category] = (acc[tool.category] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    const totalCost = all.reduce((sum, tool) => sum + tool.cost, 0);
    const avgCost = totalCost / all.length;

    return {
        total: all.length,
        byCategory,
        totalCost,
        avgCost: Math.round(avgCost * 100) / 100,
    };
}
