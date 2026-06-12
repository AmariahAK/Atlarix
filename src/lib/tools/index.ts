/**
 * Atlarix Tools Index
 * ===================
 * Central export for all tools.
 *
 * Importing this file (side-effect imports below) auto-registers every tool
 * with the ToolRegistry singleton.
 */

// Registry
export * from "./registry";

// Tool modules (importing registers them)
import "./file";
import "./glob";
import "./grep";
import "./mcp";
import "./edit";
import "./shell";
import "./web";
import "./blueprint";
// get_diagram removed — model uses get_blueprint + inline ```graph fences
import "./spawn-task";
import "./workspace";
import "./plan";
import "./browser"; // v11 in-app browser agent tools

// Re-export registry for convenience
import { ToolRegistry } from "./registry";
export { ToolRegistry };

/**
 * Initialize all tools.
 * Call this once at app startup.
 */
export function initializeTools(): void {
    const all = ToolRegistry.getAll();
    const names = all.map((t) => t.name).sort();
    console.log(`[Atlarix] ${names.length} tools registered:\n  ${names.join("\n  ")}`);
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

    // v12 3.9 (resolved): tool `cost` is informational/reporting-only today —
    // its only consumer is this stats rollup. The 2.1 capability-profile work
    // wires it into toolset trimming for low-capability models.
    const totalCost = all.reduce((sum, tool) => sum + tool.cost, 0);
    const avgCost = totalCost / all.length;

    return {
        total: all.length,
        byCategory,
        totalCost,
        avgCost: Math.round(avgCost * 100) / 100,
    };
}
