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
import "./spawn-task";
import "./workspace";
import "./plan";
import "./task-complete"; // explicit completion signal (native FC; replaces <task_complete> XML)
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
    return {
        total: ToolRegistry.getAll().length,
    };
}
