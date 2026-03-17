/**
 * Tool Session Loader — v4.0 Progressive Tool Reveal
 * Tracks which tools have been called in this session; returns full schemas for loaded tools.
 */

import type { ToolMetadata } from "./registry";
import { CORE_TOOL_NAMES } from "./ToolManifest";

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

/**
 * Tracks loaded tools for the current session (starts with core tools only).
 */
export class ToolSessionLoader {
  private loadedTools: Set<string> = new Set(CORE_TOOL_NAMES);

  constructor(private getToolMetadata: (name: string) => ToolMetadata | undefined) {}

  /**
   * Mark a tool as used and return its full schema.
   */
  onToolCall(toolName: string): ToolSchema | null {
    const tool = this.getToolMetadata(toolName);
    if (!tool) return null;
    this.loadedTools.add(toolName);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }

  /**
   * Get full schemas for all tools currently loaded in this session.
   */
  getLoadedSchemas(): ToolSchema[] {
    const schemas: ToolSchema[] = [];
    for (const name of this.loadedTools) {
      const tool = this.getToolMetadata(name);
      if (tool) {
        schemas.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        });
      }
    }
    return schemas;
  }

  getLoadedToolNames(): Set<string> {
    return new Set(this.loadedTools);
  }

  reset(): void {
    this.loadedTools = new Set(CORE_TOOL_NAMES);
  }
}
