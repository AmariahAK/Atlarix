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
  type PlanChecklistStep,
  type PlanStepState,
} from "@/lib/tasks/plan-checklist";
import { broadcastPlanArtifactUpdated } from "@/ipc/utils/emit_plan_artifact";
import { markPlanLedgerDirty } from "@/lib/tasks/plan-ledger-refresh";
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

/**
 * Resolve the plan artifact id to operate on. v14.8.7 §A1(a): planId is now
 * OPTIONAL for the mutation ops — when omitted we target the session's latest
 * plan. Threading the id was the top failure mode (weak models drop it), so one
 * call can mark a step without first re-reading the plan to recover the id.
 */
async function resolvePlanId(args: PlanToolArgs): Promise<string | null> {
  if (args.planId) return args.planId;
  const sessionId = await resolveSessionId(args);
  if (!sessionId) return null;
  // Match loadActivePlanSection's selection EXACTLY (building-first, then
  // latest). It builds the in-context ledger from the "building" row; if this
  // resolved to a different row the model would be updating one plan while
  // reading another's progress — an unwinnable disagreement.
  const row =
    (await getLatestPlanArtifact(sessionId, "building")) ??
    (await getLatestPlanArtifact(sessionId));
  return row?.id ?? null;
}

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
  // Rewriting the plan is the documented escape hatch when a step can't be
  // matched — so it has to actually be safe. Without a planId this used to
  // INSERT a new artifact, and since weak models routinely drop the id (the
  // reason planId is optional at all), a mid-work "resync" rewrite forked the
  // plan: the tool then updated one row while the in-context ledger was built
  // from another, and the two could never agree again.
  //
  // So: target the in-flight plan (the same building-first row the ledger uses)
  // and update it in place. A new artifact is created only when there's nothing
  // in flight — no plan yet, or the last one is already `built`, which means
  // this is a genuinely new task and the finished plan should be kept as history.
  let targetId = args.planId?.trim() || null;
  let isNew = false;
  if (!targetId) {
    const active =
      (await getLatestPlanArtifact(sessionId, "building")) ??
      (await getLatestPlanArtifact(sessionId));
    targetId = active && active.planStatus !== "built" ? active.id : null;
  }
  let row = targetId
    ? await updatePlanArtifactContent(targetId, args.content)
    : null;
  if (!row) {
    row = await createPlanArtifact(sessionId, args.content, args.title);
    isNew = true;
  }
  if (!row) {
    return { success: false, error: "Failed to create plan." };
  }
  broadcastPlanArtifactUpdated({
    planId: row.id,
    sessionId: row.sessionId,
    content: row.content,
    planStatus: row.planStatus,
  });
  // A rewrite changes the counts as much as an update_step does.
  markPlanLedgerDirty(args.chatId, row.content);
  const steps = parsePlanChecklist(row.content);
  const done = steps.filter((s) => s.state === "done").length;
  return {
    success: true,
    planId: row.id,
    planStatus: row.planStatus,
    contentPreview: row.content.slice(0, 400),
    marker: planArtifactMarker(row.id),
    progress: `${done}/${steps.length} steps done`,
    message: isNew ? "Plan created." : "Plan updated.",
  };
}

async function setStatus(args: PlanToolArgs) {
  const allowed: PlanArtifactStatus[] = ["plan", "building", "built"];
  const next = args.plan_status as PlanArtifactStatus;
  if (!allowed.includes(next)) {
    return { success: false, error: "plan_status must be plan, building, or built." };
  }
  const planId = await resolvePlanId(args);
  if (!planId) {
    return { success: false, error: "No plan to update — create one with plan({ operation: 'write' }) first." };
  }
  const row = await setPlanArtifactStatus(planId, next);
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

/**
 * Compact one-line checklist for the update_step not-found error — carries the
 * state the model needs to self-correct in ONE follow-up call (no plan(read)
 * round-trip, which only strong models think to do). Capped for token safety.
 */
function formatStepsForError(steps: PlanChecklistStep[]): string {
  const MARK: Record<string, string> = {
    todo: " ",
    in_progress: "~",
    done: "x",
    blocked: "!",
  };
  const shown = steps
    .slice(0, 20)
    .map((s) => `${s.index}.[${MARK[s.state] ?? " "}] ${s.text.slice(0, 60)}`);
  const more = steps.length > 20 ? ` …and ${steps.length - 20} more` : "";
  return shown.join("; ") + more;
}

async function updateStep(args: PlanToolArgs) {
  const allowed: PlanStepState[] = ["todo", "in_progress", "done", "blocked"];
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
  const planId = await resolvePlanId(args);
  if (!planId) {
    return {
      success: false,
      error: "No plan to update — create one with plan({ operation: 'write' }) first.",
    };
  }
  const row = await getPlanArtifact(planId);
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
      error:
        steps.length === 0
          ? "The plan has no checklist steps yet — rewrite it with operation:'write' using numbered '1. [ ] …' items."
          : `Step not found in plan checklist. Current steps: ${formatStepsForError(steps)}. ` +
            "Retry with step_text (a unique substring of the step) — or rewrite the whole plan with operation:'write' and updated [x]/[~] marks (always safe).",
    };
  }
  if (!result.changed) {
    // Report progress here TOO. This branch fires exactly when the model is
    // re-marking something it already marked — i.e. when it has lost track — so
    // omitting the counts left it with no way to correct itself, and it would
    // keep re-marking and rewriting the plan trying to force agreement.
    const steps = parsePlanChecklist(row.content);
    const done = steps.filter((s) => s.state === "done").length;
    return {
      success: true,
      planId: row.id,
      step: result.step,
      progress: `${done}/${steps.length} steps done`,
      message: "Step already in that state — no change needed.",
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
  // Refresh the in-context ledger for the rest of THIS turn; without it the
  // step-0 snapshot keeps asserting stale counts for every later step.
  markPlanLedgerDirty(args.chatId, updated.content);
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
  if (!args.step_text?.trim()) {
    return { success: false, error: "step_text is required for operation 'append_step'." };
  }
  const planId = await resolvePlanId(args);
  if (!planId) {
    return { success: false, error: "No plan to append to — create one with plan({ operation: 'write' }) first." };
  }
  const row = await appendStepToPlanArtifact(planId, args.step_text);
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
    "Session implementation plan + LIVE progress ledger (stored in the database, shown as a card in chat). Keep it current: mark a step in_progress when you start it and done when you finish, and consult it before deciding your next action instead of re-deriving progress. For the mutation ops, planId is OPTIONAL — the session's latest plan is assumed. Operations: " +
    "'write' (create OR update the plan markdown — the CANONICAL way to update progress when several steps changed or you're unsure of numbering: re-emit the full plan with updated [x]/[~]/[!] marks, which is always safe and cannot miss. Include the returned marker comment in your reply so the card renders; pass planId to update a specific plan), " +
    "'read' (latest plan, or by planId / status filter — re-read before continuing if the user may have edited the plan), " +
    "'set_status' (plan_status: plan → building → built), " +
    "'update_step' (convenience for marking ONE step: state in_progress|done|todo|blocked + step_text (preferred — a unique substring of the step) or step_index), " +
    "'append_step' (step_text — add a new checklist item).",
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
        description: "Plan artifact id — optional for all ops; when omitted the session's latest plan is used.",
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
        description:
          "update_step fallback: 1-based checklist step number as shown by plan read — prefer step_text",
        required: false,
      },
      step_text: {
        type: "string",
        description:
          "update_step preferred: the step's text (or a unique substring of it)",
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
