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
import "./mcp-servers"; // find MCP servers, suggest one to connect, start/stop/disconnect
import "./edit";
import "./shell";
import "./background-jobs"; // v14 list/output/cancel for background commands
import "./schedule-wakeup"; // R1 model-scheduled self-wake
import "./relic"; // pages the agent makes to share (hosted on paid Core, local otherwise)
import "./web";
import "./spawn-task";
import "./proposals"; // v14.21 review writer sub-agent edit proposals
import "./subagents"; // v14.21 list/output/cancel for running sub-agents
import "./workspace";
import "./plan";
import "./automations"; // v14.27 agent-visible standing automations
import "./browser"; // agent browser tools — the user's Chrome via the extension (v14.52)
import "./mobile"; // v14.41 emulator/simulator read + act (Build/Debug only)
import "./tool-help"; // v14.34 full usage for tools bound with a one-line summary
import "./sessions"; // v14.39 read behind the compaction boundary
import "./media"; // view_image, transcribe_audio
import "./peers"; // list and message the user's other Atlarix sessions

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
  console.log(
    `[Atlarix] ${names.length} tools registered:\n  ${names.join("\n  ")}`,
  );
}

/**
 * Get tool statistics
 */
export function getToolStats() {
  return {
    total: ToolRegistry.getAll().length,
  };
}
