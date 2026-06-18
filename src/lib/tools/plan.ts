/**
 * `plan` — ONE tool over session plan artifacts (v13; replaces get_plan_scope /
 * read_implementation_plan / write_implementation_plan / update_plan_status /
 * update_plan_step). Artifacts live in SQLite per session; the plan card/panel
 * pipeline is unchanged.
 */

import {
  ToolRegistry,
  createParameters,
  stringParam,
  enumParam,
} from "./registry";
import {
  createPlanArtifact,
  getLatestPlanArtifact,
  getPlanArtifact,
  updatePlanArtifactContent,
  appendStepToPlanArtifact,
  setPlanArtifactStatus,
  planArtifactMarker,
} from "@/lib/plans/plan-artifacts";
import {
  parsePlanChecklist,
  setStepStateInPlanMarkdown,
  type PlanStepState,
} from "@/lib/tasks/plan-checklist";
import { broadcastPlanArtifactUpdated } from "@/ipc/utils/emit_plan_artifact";
import { resolveOrBindWorkspaceSessionForStream } from "@/ipc/handlers/workspace_session_handlers";
import type { PlanArtifactStatus } from "@/db/schema";

type PlanToolArgs = {
  operation: "read" | "write" | "set_status" | "update_step" | "append_step";
  workspaceSessionId?: string;
  /** Injected by the tool funnel; used to auto-rebind a lost session. */
  chatId?: number;
  workspaceAppId?: number;
  planId?: string;
  /** write */
  content?: string;
  title?: string;
  /** read */
  status?: string;
  /** set_status */
  plan_status?: string;
  /** update_step */
  state?: string;
  step_index?: number;
  step_text?: string;
};

/**
 * Resolve the workspace session id, auto-rebinding when the stream transport
 * lost its binding (a reload can leave `workspaceSessionId` empty). Returns null
 * only when nothing can be bound (e.g. no transport for this chat).
 */
async function resolveSessionId(args: PlanToolArgs): Promise<string | null> {
  const provided = args.workspaceSessionId?.trim();
  if (provided) return provided;
  if (args.chatId == null) return null;
  try {
    return await resolveOrBindWorkspaceSessionForStream({
      chatId: args.chatId,
      workspaceAppId: args.workspaceAppId ?? null,
    });
  } catch {
    return null;
  }
}

const NO_SESSION_ERROR =
  "No workspace session for this chat — start a new chat in this workspace and retry.";

async function readPlan(args: PlanToolArgs) {
  if (args.planId) {
    const row = await getPlanArtifact(args.planId);
    if (!row) return { success: true, content: null, message: "Plan not found." };
    return {
      success: true,
      planId: row.id,
      content: row.content,
      planStatus: row.planStatus,
      marker: planArtifactMarker(row.id),
    };
  }
  const sessionId = await resolveSessionId(args);
  if (!sessionId) {
    return { success: false, error: NO_SESSION_ERROR };
  }
  const filter = args.status as PlanArtifactStatus | undefined;
  const row = await getLatestPlanArtifact(sessionId, filter);
  if (!row) {
    return { success: true, content: null, message: "No plan in this session yet." };
  }
  return {
    success: true,
    planId: row.id,
    content: row.content,
    planStatus: row.planStatus,
    marker: planArtifactMarker(row.id),
  };
}

async function writePlan(args: PlanToolArgs) {
  const sessionId = await resolveSessionId(args);
  if (!sessionId) {
    return { success: false, error: NO_SESSION_ERROR };
  }
  if (!args.content?.trim()) {
    return { success: false, error: "Plan content is required for operation 'write'." };
  }
  const row = args.planId
    ? await updatePlanArtifactContent(args.planId, args.content)
    : await createPlanArtifact(sessionId, args.content, args.title);
  if (!row) {
    return {
      success: false,
      error: args.planId ? "Plan not found." : "Failed to create plan.",
    };
  }
  return {
    success: true,
    planId: row.id,
    planStatus: row.planStatus,
    contentPreview: row.content.slice(0, 400),
    marker: planArtifactMarker(row.id),
    message: args.planId ? "Plan updated." : "Plan created.",
  };
}

async function setStatus(args: PlanToolArgs) {
  const allowed: PlanArtifactStatus[] = ["plan", "building", "built"];
  const next = args.plan_status as PlanArtifactStatus;
  if (!args.planId) {
    return { success: false, error: "planId is required for operation 'set_status'." };
  }
  if (!allowed.includes(next)) {
    return { success: false, error: "plan_status must be plan, building, or built." };
  }
  const row = await setPlanArtifactStatus(args.planId, next);
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
}

async function updateStep(args: PlanToolArgs) {
  const allowed: PlanStepState[] = ["todo", "in_progress", "done", "blocked"];
  if (!args.planId) {
    return { success: false, error: "planId is required for operation 'update_step'." };
  }
  if (!allowed.includes(args.state as PlanStepState)) {
    return {
      success: false,
      error: "state must be one of: in_progress, done, todo, blocked.",
    };
  }
  if (args.step_index == null && !args.step_text?.trim()) {
    return {
      success: false,
      error: "Provide step_index (1-based) or step_text to identify the step.",
    };
  }
  const row = await getPlanArtifact(args.planId);
  if (!row) {
    return {
      success: false,
      error:
        "Plan not found. Use the planId from the active session plan in context, or plan({ operation: 'read' }) to find it.",
    };
  }
  const result = setStepStateInPlanMarkdown(
    row.content,
    { stepIndex: args.step_index ?? undefined, stepText: args.step_text ?? undefined },
    args.state as PlanStepState,
  );
  if (!result.step) {
    const steps = parsePlanChecklist(row.content);
    return {
      success: false,
      error: `Step not found in plan checklist (${steps.length} steps). plan({ operation: 'read' }) shows the numbered steps; retry with a valid step_index.`,
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
  const updated = await updatePlanArtifactContent(args.planId, result.content);
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
}

async function appendStep(args: PlanToolArgs) {
  if (!args.planId) {
    return { success: false, error: "planId is required for operation 'append_step'." };
  }
  if (!args.step_text?.trim()) {
    return { success: false, error: "step_text is required for operation 'append_step'." };
  }
  const row = await appendStepToPlanArtifact(args.planId, args.step_text);
  if (!row) return { success: false, error: "Plan not found." };
  broadcastPlanArtifactUpdated({
    planId: row.id,
    sessionId: row.sessionId,
    content: row.content,
    planStatus: row.planStatus,
  });
  const steps = parsePlanChecklist(row.content);
  return {
    success: true,
    planId: row.id,
    stepCount: steps.length,
    message: "Step appended.",
  };
}

ToolRegistry.register({
  name: "plan",
  description:
    "Session implementation plan (stored in the database, shown as a card in chat). Operations: " +
    "'write' (create/update the plan markdown — include the returned marker comment in your reply so the card renders; pass planId to update), " +
    "'read' (latest plan, or by planId / status filter — re-read before continuing if the user may have edited the plan), " +
    "'set_status' (planId + plan_status: plan → building → built), " +
    "'update_step' (planId + state in_progress|done|todo|blocked + step_index or step_text — call as you start/finish each step so the card shows live progress), " +
    "'append_step' (planId + step_text — add a new checklist item without rewriting the plan).",
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: false,
  parameters: createParameters(
    {
      operation: enumParam("Plan operation", "read", [
        "read",
        "write",
        "set_status",
        "update_step",
        "append_step",
      ]),
      workspaceSessionId: stringParam("Workspace session id (auto-injected)"),
      planId: {
        type: "string",
        description: "Plan artifact id (required for set_status/update_step; optional otherwise)",
        required: false,
      },
      content: {
        type: "string",
        description: "write: full markdown plan body",
        required: false,
      },
      title: {
        type: "string",
        description: "write: optional title when creating a new plan",
        required: false,
      },
      status: {
        type: "string",
        description: "read: optional filter plan | building | built (latest match)",
        required: false,
      },
      plan_status: {
        type: "string",
        description: "set_status: one of plan, building, built",
        required: false,
      },
      state: {
        type: "string",
        description: "update_step: one of in_progress, done, todo, blocked",
        required: false,
      },
      step_index: {
        type: "number",
        description: "update_step: 1-based checklist step number",
        required: false,
      },
      step_text: {
        type: "string",
        description: "update_step: step text (or unique substring) when index is unknown",
        required: false,
      },
    },
    ["operation"],
  ),
  handler: async (args: PlanToolArgs) => {
    switch (args.operation) {
      case "write":
        return writePlan(args);
      case "set_status":
        return setStatus(args);
      case "update_step":
        return updateStep(args);
      case "append_step":
        return appendStep(args);
      case "read":
      default:
        return readPlan(args);
    }
  },
});
