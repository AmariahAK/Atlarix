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
import "./testing-tools";
import "./refactoring-tools";
import "./project-structure-tools"; // Multi-Layer Fallback System
import "./meta-tools"; // Phase 3: New meta-tools


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
