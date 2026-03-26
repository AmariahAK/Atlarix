/**
 * v5.0 Section 2 — project memory tools (snapshots + key/value).
 */

import { ToolRegistry, ToolCategory, createParameters, stringParam } from "./registry";
import {
  listProjectSnapshots,
  listProjectMemoryKeys,
  upsertProjectMemoryKey,
} from "@/lib/project-memory/service";

ToolRegistry.register({
  name: "get_project_history",
  description:
    "List recent project snapshots (blueprint + plan checkpoints) and stored memory keys for this workspace. Use to summarize past state or before revert_to_snapshot.",
  category: ToolCategory.MEMORY,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID" },
      limit: { type: "number", description: "Max snapshots (default 20)", required: false },
    },
    ["workspaceId"],
  ),
  handler: async ({ workspaceId, limit }: { workspaceId: number; limit?: number }) => {
    const lim = limit != null && limit > 0 ? Math.min(limit, 50) : 20;
    const snapshots = await listProjectSnapshots(workspaceId, lim);
    const memory = await listProjectMemoryKeys(workspaceId);
    return {
      success: true,
      snapshots,
      memoryKeys: memory.map((m) => ({ key: m.key, valuePreview: m.value.slice(0, 300) })),
    };
  },
});

ToolRegistry.register({
  name: "revert_to_snapshot",
  description:
    "Restore blueprint JSON and .atlarix/ATLARIX_PLAN.md from a stored project snapshot (requires user approval). Call get_project_history first to pick snapshot id.",
  category: ToolCategory.MEMORY,
  cost: 5,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID" },
      snapshotId: { type: "number", description: "Snapshot id from get_project_history" },
      reason: stringParam("Short reason for revert"),
    },
    ["workspaceId", "snapshotId", "reason"],
  ),
  handler: async ({
    workspaceId,
    snapshotId,
    reason,
  }: {
    workspaceId: number;
    snapshotId: number;
    reason: string;
  }) => {
    const { getProjectSnapshotRow } = await import("@/lib/project-memory/service");
    const row = await getProjectSnapshotRow(snapshotId, workspaceId);
    if (!row) {
      return { success: false, error: "Snapshot not found for this workspace" };
    }
    return {
      __permission_required: true,
      operation: "revert_project_snapshot",
      preview: {
        snapshotId,
        label: `Revert to snapshot #${snapshotId}: ${reason.slice(0, 120)}`,
        planExcerpt: row.planMd ? row.planMd.slice(0, 400) : undefined,
      },
      reasoning: reason,
    };
  },
});

ToolRegistry.register({
  name: "set_project_memory",
  description:
    "Store a durable key/value fact for this workspace (shown in future session system prompts). Values are truncated; prefer concise facts.",
  category: ToolCategory.MEMORY,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID" },
      key: stringParam("Short key (e.g. preferred_stack, auth_model)"),
      value: stringParam("Value text"),
    },
    ["workspaceId", "key", "value"],
  ),
  handler: async ({ workspaceId, key, value }: { workspaceId: number; key: string; value: string }) => {
    await upsertProjectMemoryKey(workspaceId, key, value);
    return { success: true, key, message: "Stored in project_memory" };
  },
});
