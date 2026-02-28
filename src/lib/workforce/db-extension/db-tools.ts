/**
 * DB Extension — AI tool definitions for the tool registry.
 * Handlers are invoked via IPC from main process.
 */

import type { ToolMetadata } from "@/lib/tools/registry";
import { ToolCategory } from "@/lib/tools/registry";

export const DB_TOOL_NAMES = ["db_query", "db_schema", "db_list", "db_mutate"] as const;

export function getDBTools(): ToolMetadata[] {
  return [
    {
      name: "db_query",
      description: "Run a read-only SQL query against the active database connection. Use for SELECT only.",
      category: ToolCategory.SEARCH,
      cost: 0,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "SQL SELECT query to run" },
        },
        required: ["query"],
      },
      handler: async () => ({ result: "DB query executed via IPC", success: true }),
      requiresWorkspace: true,
      isReadOnly: true,
    },
    {
      name: "db_schema",
      description: "Get the full schema (tables, columns, types, foreign keys) for the active database connection.",
      category: ToolCategory.SEARCH,
      cost: 0,
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => ({ result: "Schema returned via IPC", success: true }),
      requiresWorkspace: true,
      isReadOnly: true,
    },
    {
      name: "db_list",
      description: "List configured database connections and the active connection for this workspace.",
      category: ToolCategory.SEARCH,
      cost: 0,
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => ({ result: "Connections list via IPC", success: true }),
      requiresWorkspace: false,
      isReadOnly: true,
    },
    {
      name: "db_mutate",
      description: "Execute a write SQL statement (INSERT/UPDATE/DELETE/DDL). Requires user approval before execution.",
      category: ToolCategory.FILE,
      cost: 0,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "SQL write statement" },
          reason: { type: "string", description: "Brief reason for the change" },
        },
        required: ["query"],
      },
      handler: async () => ({ result: "DB mutate queued for approval via IPC", success: true }),
      requiresWorkspace: true,
      isReadOnly: false,
    },
  ];
}
