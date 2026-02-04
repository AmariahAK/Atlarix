/**
 * Blueprint tools (Phase 7 Additive Blueprint)
 * ============================================
 * AI can read and update the blueprint (rooms, functions, edges).
 * When the AI edits the blueprint, we emit blueprint:ai-editing for the Diagram tab indicator.
 */

import { ToolRegistry, ToolCategory, createParameters, stringParam } from "./registry";
import type { Blueprint, BlueprintRoom, BlueprintFunction, BlueprintEdge, BlueprintFunctionKind } from "../../shared/blueprint-types";
import { generateBlueprintId } from "../../shared/blueprint-types";
import {
  getBlueprintForWorkspace,
  setBlueprintForWorkspace,
  emitBlueprintAiEditing,
} from "../../ipc/handlers/blueprint_handlers";

// ═══════════════════════════════════════════════════════════
// GET BLUEPRINT
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "get_blueprint",
  description: "Read the current Blueprint for the workspace (rooms, functions per room, edges). Use before making changes.",
  category: ToolCategory.DIAGRAM,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters({ workspaceId: { type: "number", description: "Workspace ID" } }, ["workspaceId"]),
  handler: async ({ workspaceId }: { workspaceId: number }) => {
    const blueprint = await getBlueprintForWorkspace(workspaceId);
    return {
      success: true,
      blueprint,
      summary: `${blueprint.rooms.length} room(s), ${blueprint.edges.length} edge(s). Rooms: ${blueprint.rooms.map((r) => r.label).join(", ") || "none"}.`,
    };
  },
});

// ═══════════════════════════════════════════════════════════
// ADD BLUEPRINT ROOM
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "add_blueprint_room",
  description: "Add a new room to the Blueprint. Rooms are named by the user; what matters are the functions/APIs/webhooks inside.",
  category: ToolCategory.DIAGRAM,
  cost: 2,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID" },
      label: stringParam("Room name (e.g. Auth API, Worker, DB)"),
      intent: stringParam("Short intent (optional)"),
      type: stringParam("Room type (optional): api, db, worker, frontend, etc."),
    },
    ["workspaceId", "label"]
  ),
  handler: async ({
    workspaceId,
    label,
    intent,
    type,
  }: {
    workspaceId: number;
    label: string;
    intent?: string;
    type?: string;
  }) => {
    emitBlueprintAiEditing(workspaceId, "add_blueprint_room");
    const blueprint = await getBlueprintForWorkspace(workspaceId);
    const room: BlueprintRoom = {
      id: generateBlueprintId(),
      label: label.trim(),
      intent: intent?.trim(),
      type: type?.trim(),
      functions: [],
    };
    blueprint.rooms.push(room);
    await setBlueprintForWorkspace(workspaceId, blueprint);
    return { success: true, roomId: room.id, label: room.label, message: `Added room "${room.label}".` };
  },
});

// ═══════════════════════════════════════════════════════════
// ADD BLUEPRINT FUNCTION
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "add_blueprint_function",
  description: "Add a function/API/webhook/feature to a room in the Blueprint.",
  category: ToolCategory.DIAGRAM,
  cost: 2,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID" },
      roomId: stringParam("Room ID (from get_blueprint)"),
      name: stringParam("Function/API/webhook name or path"),
      kind: {
        type: "string",
        description: "Kind: api, webhook, function, feature",
        required: true,
      },
      description: stringParam("Optional description or route path"),
    },
    ["workspaceId", "roomId", "name", "kind"]
  ),
  handler: async ({
    workspaceId,
    roomId,
    name,
    kind,
    description,
  }: {
    workspaceId: number;
    roomId: string;
    name: string;
    kind: string;
    description?: string;
  }) => {
    emitBlueprintAiEditing(workspaceId, "add_blueprint_function");
    const blueprint = await getBlueprintForWorkspace(workspaceId);
    const room = blueprint.rooms.find((r) => r.id === roomId);
    if (!room) return { success: false, error: `Room ${roomId} not found. Use get_blueprint to list rooms.` };
    const fn: BlueprintFunction = {
      id: generateBlueprintId(),
      name: name.trim(),
      kind: (kind as BlueprintFunctionKind) || "function",
      description: description?.trim(),
    };
    room.functions.push(fn);
    await setBlueprintForWorkspace(workspaceId, blueprint);
    return { success: true, functionId: fn.id, room: room.label, message: `Added ${fn.kind} "${fn.name}" to room "${room.label}".` };
  },
});

// ═══════════════════════════════════════════════════════════
// ADD BLUEPRINT EDGE
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "add_blueprint_edge",
  description: "Add a connection between two rooms in the Blueprint (e.g. API → DB).",
  category: ToolCategory.DIAGRAM,
  cost: 2,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID" },
      fromRoomId: stringParam("Source room ID"),
      toRoomId: stringParam("Target room ID"),
      label: stringParam("Optional edge label (e.g. reads, writes)"),
    },
    ["workspaceId", "fromRoomId", "toRoomId"]
  ),
  handler: async ({
    workspaceId,
    fromRoomId,
    toRoomId,
    label,
  }: {
    workspaceId: number;
    fromRoomId: string;
    toRoomId: string;
    label?: string;
  }) => {
    emitBlueprintAiEditing(workspaceId, "add_blueprint_edge");
    const blueprint = await getBlueprintForWorkspace(workspaceId);
    const fromExists = blueprint.rooms.some((r) => r.id === fromRoomId);
    const toExists = blueprint.rooms.some((r) => r.id === toRoomId);
    if (!fromExists || !toExists)
      return { success: false, error: `Room not found. Use get_blueprint to list room IDs.` };
    const edge: BlueprintEdge = { from: fromRoomId, to: toRoomId, label: label?.trim() };
    blueprint.edges.push(edge);
    await setBlueprintForWorkspace(workspaceId, blueprint);
    return { success: true, message: `Added connection ${fromRoomId} → ${toRoomId}.` };
  },
});

// ═══════════════════════════════════════════════════════════
// UPDATE BLUEPRINT (full replace)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "update_blueprint",
  description: "Replace the entire Blueprint with a new structure (rooms, edges). Use when doing many changes at once.",
  category: ToolCategory.DIAGRAM,
  cost: 5,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID" },
      blueprint: {
        type: "object",
        description: "Full blueprint: { rooms: [{ id, label, type?, intent?, functions: [{ id, name, kind }] }], edges: [{ from, to, label? }] }",
        required: true,
      },
    },
    ["workspaceId", "blueprint"]
  ),
  handler: async ({ workspaceId, blueprint: input }: { workspaceId: number; blueprint: Blueprint }) => {
    emitBlueprintAiEditing(workspaceId, "update_blueprint");
    const blueprint: Blueprint = {
      rooms: Array.isArray(input.rooms) ? input.rooms : [],
      edges: Array.isArray(input.edges) ? input.edges : [],
      envRefs: input.envRefs ?? [],
    };
    await setBlueprintForWorkspace(workspaceId, blueprint);
    return { success: true, message: `Blueprint updated: ${blueprint.rooms.length} rooms, ${blueprint.edges.length} edges.` };
  },
});

// ═══════════════════════════════════════════════════════════
// COMPARE BLUEPRINT TO LIVE
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "compare_blueprint_to_live",
  description: "Compare the Blueprint (desired) to the Live diagram (current code). Returns both and a short diff so you can plan tasks. Use before generating code from the Blueprint.",
  category: ToolCategory.DIAGRAM,
  cost: 3,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters({ workspaceId: { type: "number", description: "Workspace ID" } }, ["workspaceId"]),
  handler: async ({ workspaceId }: { workspaceId: number }) => {
    const blueprint = await getBlueprintForWorkspace(workspaceId);
    let liveMermaid = "";
    try {
      const { getWorkspaceContext } = await import("../../ipc/handlers/chat_stream/workspace-context");
      const { apps } = await import("../../db/schema");
      const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
      if (app?.path) {
        const ctx = await getWorkspaceContext(app.path);
        if (ctx?.diagram) liveMermaid = ctx.diagram;
      }
    } catch {
      // ignore
    }
    const liveRooms = liveMermaid ? "Live diagram has content (see live_mermaid)." : "No Live diagram yet.";
    const bpRooms = blueprint.rooms.map((r) => `${r.label} (${r.functions.length} functions)`).join("; ") || "None.";
    const diff = blueprint.rooms.length === 0
      ? "Blueprint is empty. Add rooms and functions in the Diagram tab (Blueprint mode) or via add_blueprint_room / add_blueprint_function."
      : `Blueprint has ${blueprint.rooms.length} room(s): ${bpRooms}. ${blueprint.edges.length} edge(s). Compare to Live to plan implementation.`;
    return {
      success: true,
      live_mermaid: liveMermaid || "(none)",
      blueprint,
      summary: diff,
      recommendation: "Use the Blueprint to create an implementation plan (tasks), then implement exchange-by-exchange with user review between tasks.",
    };
  },
});

// ═══════════════════════════════════════════════════════════
// CODEGEN FROM BLUEPRINT DELTA (Phase 7)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "generate_from_blueprint",
  description: "Generate scaffold from Blueprint delta: new stub files (src/<room>.ts) and merge env refs into .env.local. Additive only (skips existing files). Use after compare_blueprint_to_live and implementation plan.",
  category: ToolCategory.DIAGRAM,
  cost: 5,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID" },
      delta: {
        type: "object",
        description: "Delta: { rooms: BlueprintRoom[], edges: { from, to, label? }[], envRefs: string[] }. Use new rooms/edges/envRefs to add.",
        required: true,
      },
    },
    ["workspaceId", "delta"]
  ),
  handler: async ({
    workspaceId,
    delta,
  }: {
    workspaceId: number;
    delta: { rooms: BlueprintRoom[]; edges: { from: string; to: string; label?: string }[]; envRefs?: string[] };
  }) => {
    const { generateFromBlueprintDelta } = await import("../blueprint/codegen");
    const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
    if (!app?.path) return { success: false, error: "Workspace not found" };
    const { getAtlarixAppPath } = await import("../../paths/paths");
    const workspacePath = getAtlarixAppPath(app.path);
    const result = await generateFromBlueprintDelta(workspacePath, {
      rooms: delta.rooms ?? [],
      edges: delta.edges ?? [],
      envRefs: delta.envRefs ?? [],
    });
    return {
      success: result.errors.length === 0,
      ...result,
      message: result.errors.length
        ? `Codegen had errors: ${result.errors.join("; ")}`
        : `Created ${result.filesCreated.length} file(s), added ${result.envKeysAdded.length} env key(s) to .env.local.`,
    };
  },
});

// ═══════════════════════════════════════════════════════════
// IMPLEMENTATION PLAN (Atlarix_Plan.md / .atlarix/PLAN.md)
// ═══════════════════════════════════════════════════════════

const PLAN_PATH = ".atlarix/PLAN.md";

ToolRegistry.register({
  name: "read_implementation_plan",
  description: "Read the implementation plan file (.atlarix/PLAN.md) if it exists. Use to refresh context on the current task list.",
  category: ToolCategory.DIAGRAM,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters(
    { workspace: stringParam("Workspace root path (auto-injected)") },
    []
  ),
  handler: async ({ workspace }: { workspace?: string }) => {
    if (!workspace) return { success: false, error: "Workspace path required" };
    const path = await import("path");
    const fs = await import("fs/promises");
    const fullPath = path.join(workspace, PLAN_PATH);
    try {
      const content = await fs.readFile(fullPath, "utf8");
      return { success: true, content, path: PLAN_PATH };
    } catch (err: any) {
      if (err?.code === "ENOENT") return { success: true, content: null, path: PLAN_PATH, message: "No plan file yet." };
      return { success: false, error: err?.message ?? String(err) };
    }
  },
});

ToolRegistry.register({
  name: "write_implementation_plan",
  description: "Create or update the implementation plan file (.atlarix/PLAN.md). Use after compare_blueprint_to_live to write the task list. Requires user approval.",
  category: ToolCategory.DIAGRAM,
  cost: 3,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      workspace: stringParam("Workspace root path (auto-injected)"),
      content: stringParam("Full markdown content of the plan (tasks, order, notes)"),
      description: stringParam("Brief description of what this plan does"),
      chatMode: { type: "string", description: "Build or ask (auto-injected)", required: false },
    },
    ["content"]
  ),
  handler: async ({
    workspace,
    content,
    description,
    chatMode,
  }: {
    workspace?: string;
    content: string;
    description?: string;
    chatMode?: string;
  }) => {
    if (chatMode === "ask") {
      return {
        error: "Write operations not allowed in Ask mode. Switch to Build mode to create/update the implementation plan.",
        operation: "write_file",
        denied: true,
      };
    }
    if (!workspace) return { success: false, error: "Workspace path required" };
    const path = await import("path");
    const fs = await import("fs/promises");
    const fullPath = path.join(workspace, PLAN_PATH);
    let fileType: "create" | "update" = "create";
    let oldContent: string | undefined;
    try {
      await fs.access(fullPath);
      fileType = "update";
      oldContent = await fs.readFile(fullPath, "utf8");
    } catch {
      fileType = "create";
    }
    return {
      __permission_required: true,
      operation: "write_file",
      preview: {
        path: PLAN_PATH,
        content,
        ...(oldContent !== undefined && { oldContent }),
        description: description ?? "Implementation plan (tasks from Blueprint comparison)",
        type: fileType,
        lines: content.split("\n").length,
      },
      reasoning: `${fileType === "update" ? "Updating" : "Creating"} ${PLAN_PATH}: ${description ?? "implementation plan"}`,
    };
  },
});
