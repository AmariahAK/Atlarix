/**
 * Plan tools — session-scoped plan artifacts (SQLite), not files.
 */

import { ToolRegistry, ToolCategory, createParameters, stringParam } from "./registry";
import {
  createPlanArtifact,
  getLatestPlanArtifact,
  getPlanArtifact,
  updatePlanArtifactContent,
  setPlanArtifactStatus,
  planArtifactMarker,
} from "@/lib/plans/plan-artifacts";
import {
  parsePlanChecklist,
  setStepStateInPlanMarkdown,
  type PlanStepState,
} from "@/lib/tasks/plan-checklist";
import { broadcastPlanArtifactUpdated } from "@/ipc/utils/emit_plan_artifact";
import type { PlanArtifactStatus } from "@/db/schema";

ToolRegistry.register({
  name: "get_plan_scope",
  description:
    "Plans are session artifacts stored in the database (not files). Use write_implementation_plan to create/update a plan for this chat session. Use .atlarix/atlarix.md for durable project notes.",
  category: ToolCategory.TASK,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters({ workspace: stringParam("Workspace root (auto-injected)") }, []),
  handler: async () => ({
    success: true,
    type: "session_artifact",
    guidance:
      "Create plans with write_implementation_plan. They appear as cards in chat and in the Plan panel when clicked. Persist project conventions in .atlarix/atlarix.md.",
  }),
});

ToolRegistry.register({
  name: "read_implementation_plan",
  description:
    "Read a session plan artifact by planId, or the latest plan / latest building plan in this session.",
  category: ToolCategory.TASK,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters(
    {
      workspaceSessionId: stringParam("Workspace session id (auto-injected)"),
      planId: {
        type: "string",
        description: "Optional plan artifact id",
        required: false,
      },
      status: {
        type: "string",
        description: "Optional filter: plan | building | built (latest match)",
        required: false,
      },
    },
    [],
  ),
  handler: async ({
    workspaceSessionId,
    planId,
    status,
  }: {
    workspaceSessionId?: string;
    planId?: string;
    status?: string;
  }) => {
    if (!workspaceSessionId) {
      return { success: false, error: "No workspace session for this chat." };
    }
    if (planId) {
      const row = await getPlanArtifact(planId);
      if (!row) return { success: true, content: null, message: "Plan not found." };
      return {
        success: true,
        planId: row.id,
        content: row.content,
        planStatus: row.planStatus,
        marker: planArtifactMarker(row.id),
      };
    }
    const filter = status as PlanArtifactStatus | undefined;
    const row = await getLatestPlanArtifact(workspaceSessionId, filter);
    if (!row) return { success: true, content: null, message: "No plan in this session yet." };
    return {
      success: true,
      planId: row.id,
      content: row.content,
      planStatus: row.planStatus,
      marker: planArtifactMarker(row.id),
    };
  },
});

ToolRegistry.register({
  name: "write_implementation_plan",
  description:
    "Create or update a session plan artifact (markdown). Plan mode only. Returns planId and an artifact marker to embed in your reply.",
  category: ToolCategory.TASK,
  cost: 3,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: false,
  parameters: createParameters(
    {
      workspaceSessionId: stringParam("Workspace session id (auto-injected)"),
      content: stringParam("Full markdown plan body"),
      planId: {
        type: "string",
        description: "Optional existing plan id to update",
        required: false,
      },
      title: {
        type: "string",
        description: "Optional title when creating a new plan",
        required: false,
      },
    },
    ["content"],
  ),
  handler: async ({
    workspaceSessionId,
    content,
    planId,
    title,
  }: {
    workspaceSessionId?: string;
    content: string;
    planId?: string;
    title?: string;
  }) => {
    if (!workspaceSessionId) {
      return { success: false, error: "No workspace session for this chat." };
    }
    if (!content?.trim()) {
      return { success: false, error: "Plan content is required." };
    }
    const row = planId
      ? await updatePlanArtifactContent(planId, content)
      : await createPlanArtifact(workspaceSessionId, content, title);
    if (!row) {
      return { success: false, error: planId ? "Plan not found." : "Failed to create plan." };
    }
    return {
      success: true,
      planId: row.id,
      planStatus: row.planStatus,
      contentPreview: row.content.slice(0, 400),
      marker: planArtifactMarker(row.id),
      message: planId ? "Plan updated." : "Plan created.",
    };
  },
});

ToolRegistry.register({
  name: "update_plan_status",
  description: "Transition a session plan: plan → building → built.",
  category: ToolCategory.TASK,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: false,
  parameters: createParameters(
    {
      planId: stringParam("Plan artifact id"),
      planStatus: stringParam("One of: plan, building, built"),
    },
    ["planId", "planStatus"],
  ),
  handler: async ({
    planId,
    planStatus,
  }: {
    planId: string;
    planStatus: string;
  }) => {
    const allowed: PlanArtifactStatus[] = ["plan", "building", "built"];
    if (!allowed.includes(planStatus as PlanArtifactStatus)) {
      return { success: false, error: "planStatus must be plan, building, or built." };
    }
    const row = await setPlanArtifactStatus(planId, planStatus as PlanArtifactStatus);
    if (!row) return { success: false, error: "Plan not found." };
    broadcastPlanArtifactUpdated({
      planId: row.id,
      sessionId: row.sessionId,
      content: row.content,
      planStatus: row.planStatus,
    });
    return {
      success: true,
      planId: row.id,
      planStatus: row.planStatus,
      marker: planArtifactMarker(row.id),
    };
  },
});

ToolRegistry.register({
  name: "update_plan_step",
  description:
    "Mark one checklist step of a session plan as in_progress, done, todo, or blocked. Call as you start and finish each step while building so the plan card shows live progress. Target by step_index (1-based) or step_text.",
  category: ToolCategory.TASK,
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: false,
  parameters: createParameters(
    {
      planId: stringParam("Plan artifact id (from the active session plan in context)"),
      state: stringParam("One of: in_progress, done, todo, blocked"),
      step_index: {
        type: "number",
        description: "1-based checklist step number",
        required: false,
      },
      step_text: {
        type: "string",
        description: "Step text (or unique substring) when index is unknown",
        required: false,
      },
    },
    ["planId", "state"],
  ),
  handler: async ({
    planId,
    state,
    step_index,
    step_text,
  }: {
    planId: string;
    state: string;
    step_index?: number;
    step_text?: string;
  }) => {
    const allowed: PlanStepState[] = ["todo", "in_progress", "done", "blocked"];
    if (!allowed.includes(state as PlanStepState)) {
      return {
        success: false,
        error: "state must be one of: in_progress, done, todo, blocked.",
      };
    }
    if (step_index == null && !step_text?.trim()) {
      return {
        success: false,
        error: "Provide step_index (1-based) or step_text to identify the step.",
      };
    }
    const row = await getPlanArtifact(planId);
    if (!row) {
      return {
        success: false,
        error: "Plan not found. Use the planId from the active session plan in context, or read_implementation_plan to list it.",
      };
    }
    const result = setStepStateInPlanMarkdown(
      row.content,
      { stepIndex: step_index ?? undefined, stepText: step_text ?? undefined },
      state as PlanStepState,
    );
    if (!result.step) {
      const steps = parsePlanChecklist(row.content);
      return {
        success: false,
        error: `Step not found in plan checklist (${steps.length} steps). Use read_implementation_plan to see the numbered steps, then retry with a valid step_index.`,
      };
    }
    if (!result.changed) {
      return {
        success: true,
        planId: row.id,
        step: result.step,
        message: "Step already in that state.",
      };
    }
    const updated = await updatePlanArtifactContent(planId, result.content);
    if (!updated) return { success: false, error: "Plan not found." };
    broadcastPlanArtifactUpdated({
      planId: updated.id,
      sessionId: updated.sessionId,
      content: updated.content,
      planStatus: updated.planStatus,
    });
    const steps = parsePlanChecklist(updated.content);
    const done = steps.filter((s) => s.state === "done").length;
    return {
      success: true,
      planId: updated.id,
      step: result.step,
      progress: `${done}/${steps.length} steps done`,
    };
  },
});
