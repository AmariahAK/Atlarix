/**
 * Terminal instance tools — list/read/open/close persisted terminal tabs.
 */

import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
  numberParam,
} from "./registry";
import { isMainProcessNode } from "@/lib/runtime/is-main-node";

async function store() {
  return import("@/lib/terminal-instance-store");
}

function mainOnly() {
  if (!isMainProcessNode()) {
    return {
      success: false,
      error: "Terminal instance tools are only available in the desktop app main process.",
    };
  }
  return null;
}

ToolRegistry.register({
  name: "list_terminal_instances",
  description:
    "List terminal tabs in the Activity panel for this chat (user shells and agent command logs). " +
    "Use before read_terminal_instance or open_terminal_instance when you need a specific tab id.",
  category: ToolCategory.EXECUTION,
  cost: 1,
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  parameters: createParameters({}, []),
  handler: async (args: {
    chatId?: number;
    workspaceId?: number;
    _chatSessionId?: number;
  }) => {
    const blocked = mainOnly();
    if (blocked) return blocked;
    const { resolveScopeKey, listTerminalInstances } = await store();
    const scopeKey = resolveScopeKey(
      args.chatId ?? args._chatSessionId,
      args.workspaceId,
    );
    const instances = listTerminalInstances(scopeKey);
    if (instances.length === 0) {
      return {
        scopeKey,
        instances: [],
        message: "No terminal instances yet. User shells appear when they run commands; agent tabs open on run_command.",
      };
    }
    return { scopeKey, instances };
  },
});

ToolRegistry.register({
  name: "read_terminal_instance",
  description:
    "Read recent output lines from a terminal tab by instance id (from list_terminal_instances).",
  category: ToolCategory.EXECUTION,
  cost: 1,
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      instance_id: stringParam("Terminal instance id"),
      max_lines: numberParam("Max lines to return (default 200, max 500)", 200, 1, 500),
    },
    ["instance_id"],
  ),
  handler: async (args: {
    instance_id: string;
    max_lines?: number;
    chatId?: number;
    workspaceId?: number;
    _chatSessionId?: number;
  }) => {
    const blocked = mainOnly();
    if (blocked) return blocked;
    const { resolveScopeKey, readTerminalInstance } = await store();
    const scopeKey = resolveScopeKey(
      args.chatId ?? args._chatSessionId,
      args.workspaceId,
    );
    return readTerminalInstance(scopeKey, args.instance_id, args.max_lines ?? 200);
  },
});

ToolRegistry.register({
  name: "open_terminal_instance",
  description:
    "Open or focus a terminal tab. Agent terminals are capped at 3 per chat; reuse operation_id to stream into the same tab. " +
    "Does not run a command — use run_command for execution.",
  category: ToolCategory.EXECUTION,
  cost: 1,
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      owner: {
        type: "string",
        enum: ["user", "agent"],
        description: "Tab owner (default: agent)",
      },
      label: stringParam("Optional display label stored on the instance"),
      command_hint: stringParam("Optional short command hint for default agent label"),
      operation_id: stringParam(
        "Optional stable id (e.g. run_command operation) to reuse the same agent tab",
      ),
    },
    [],
  ),
  handler: async (args: {
    owner?: "user" | "agent";
    label?: string;
    command_hint?: string;
    operation_id?: string;
    chatId?: number;
    workspaceId?: number;
    _chatSessionId?: number;
  }) => {
    const blocked = mainOnly();
    if (blocked) return blocked;
    const { resolveScopeKey, openTerminalInstance } = await store();
    const scopeKey = resolveScopeKey(
      args.chatId ?? args._chatSessionId,
      args.workspaceId,
    );
    return openTerminalInstance(scopeKey, {
      owner: args.owner ?? "agent",
      label: args.label,
      commandHint: args.command_hint,
      operationId: args.operation_id,
    });
  },
});

ToolRegistry.register({
  name: "close_terminal_instance",
  description:
    "Close a terminal tab by instance id. Cannot close the last user shell or the only remaining tab.",
  category: ToolCategory.EXECUTION,
  cost: 1,
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      instance_id: stringParam("Terminal instance id to close"),
    },
    ["instance_id"],
  ),
  handler: async (args: {
    instance_id: string;
    chatId?: number;
    workspaceId?: number;
    _chatSessionId?: number;
  }) => {
    const blocked = mainOnly();
    if (blocked) return blocked;
    const { resolveScopeKey, closeTerminalInstance } = await store();
    const scopeKey = resolveScopeKey(
      args.chatId ?? args._chatSessionId,
      args.workspaceId,
    );
    return closeTerminalInstance(scopeKey, args.instance_id);
  },
});
