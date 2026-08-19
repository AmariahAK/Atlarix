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
  listPlanArtifactsForSession,
  updatePlanArtifactContent,
  appendStepToPlanArtifact,
  setPlanArtifactStatus,
  planArtifactMarker,
} from "@/lib/plans/plan-artifacts";
import {
  isActionableStepState,
  parsePlanChecklist,
  setStepStateInPlanMarkdown,
  type PlanChecklistStep,
  type PlanStepState,
} from "@/lib/tasks/plan-checklist";
import log from "electron-log";
import { broadcastPlanArtifactUpdated } from "@/ipc/utils/emit_plan_artifact";
import { markPlanLedgerDirty } from "@/lib/tasks/plan-ledger-refresh";
import { resolveOrBindWorkspaceSessionForStream } from "@/ipc/handlers/workspace_session_handlers";
import type { PlanArtifactStatus } from "@/db/schema";

const logger = log.scope("plan-tool");

type PlanToolArgs = {
  operation: "read" | "write" | "set_status" | "update_step" | "append_step";
  workspaceSessionId?: string;
  /** Injected by the tool funnel; used to auto-rebind a lost session. */
  chatId?: number;
  /** Injected by the tool funnel — which window should see this plan. */
  _ownerWindowId?: number;
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
  /** update_step + state:"external" — required; what the USER has to do. */
  reason?: string;
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

/** A title matched more than one plan; the caller must disambiguate by id. */
type TitleAmbiguity = { ambiguous: true; message: string };

/**
 * Resolve a plan by TITLE within a session.
 *
 * Titles are not unique, so two matches must fail LOUDLY with both ids rather
 * than silently picking the newer one — the same guarantee `update_step` already
 * makes when it refuses to tick a step it cannot match uniquely. Silently
 * choosing would mean the model updates one plan while reading another's
 * progress, which is the exact disagreement `resolvePlanId`'s building-first
 * ordering exists to prevent.
 *
 * Matching is trimmed and case-insensitive: the model is recalling a name it
 * wrote earlier in the turn, not quoting a primary key.
 */
async function resolvePlanIdByTitle(
  sessionId: string,
  rawTitle: string,
): Promise<string | null | TitleAmbiguity> {
  const wanted = rawTitle.trim().toLowerCase();
  if (!wanted) return null;
  const rows = await listPlanArtifactsForSession(sessionId);
  const matches = rows.filter(
    (r) => (r.title ?? "").trim().toLowerCase() === wanted,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return {
      ambiguous: true,
      message:
        `${matches.length} plans in this session are titled "${rawTitle.trim()}": ` +
        matches.map((m) => `${m.id} (${m.planStatus})`).join(", ") +
        ". Re-issue the call with planId set to the one you mean.",
    };
  }
  return matches[0].id;
}

/**
 * Narrow `resolvePlanId`'s three-way result into an id or the tool result to
 * return. Kept explicit so an ambiguous title can never be silently treated as
 * "no plan" and turned into a create.
 */
function planIdOrFailure(
  resolved: string | null | TitleAmbiguity,
  noneError: string,
): { id: string; failure?: undefined } | { id?: undefined; failure: { success: false; error: string } } {
  if (resolved && typeof resolved === "object") {
    return { failure: { success: false, error: resolved.message } };
  }
  if (!resolved) return { failure: { success: false, error: noneError } };
  return { id: resolved };
}

/**
 * Resolve the plan artifact id to operate on. v14.8.7 §A1(a): planId is now
 * OPTIONAL for the mutation ops — when omitted we target the session's latest
 * plan. Threading the id was the top failure mode (weak models drop it), so one
 * call can mark a step without first re-reading the plan to recover the id.
 */
async function resolvePlanId(
  args: PlanToolArgs,
): Promise<string | null | TitleAmbiguity> {
  if (args.planId) return args.planId;
  const sessionId = await resolveSessionId(args);
  if (!sessionId) return null;
  // `title` addresses a plan on the NON-write ops (on `write` it names a plan
  // being created, which is a different meaning — see writePlan). Slotted in
  // BETWEEN planId and the positional fallback so the explicit id always wins
  // and the fallback ordering below is untouched.
  if (args.title?.trim()) {
    const byTitle = await resolvePlanIdByTitle(sessionId, args.title);
    if (byTitle && typeof byTitle === "object") return byTitle;
    if (byTitle) return byTitle;
    // No title match falls through to the positional plan rather than erroring:
    // a model that passes a stale title still gets the plan it is working on.
  }
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
      title: row.title,
      content: row.content,
      planStatus: row.planStatus,
      marker: planArtifactMarker(row.id),
    };
  }
  const sessionId = await resolveSessionId(args);
  if (!sessionId) {
    return { success: false, error: NO_SESSION_ERROR };
  }
  // Address by title when given one. A session with several plans could
  // otherwise only be navigated by opaque id or by "the newest one".
  if (args.title?.trim()) {
    const byTitle = await resolvePlanIdByTitle(sessionId, args.title);
    if (byTitle && typeof byTitle === "object") {
      return { success: false, error: byTitle.message };
    }
    if (byTitle) {
      const titled = await getPlanArtifact(byTitle);
      if (titled) {
        return {
          success: true,
          planId: titled.id,
          title: titled.title,
          content: titled.content,
          planStatus: titled.planStatus,
          marker: planArtifactMarker(titled.id),
        };
      }
    } else {
      const known = await listPlanArtifactsForSession(sessionId);
      return {
        success: true,
        content: null,
        message: known.length
          ? `No plan titled "${args.title.trim()}" in this session. Plans here: ` +
            known.map((r) => `"${r.title ?? "(untitled)"}" (${r.id})`).join(", ")
          : "No plan in this session yet.",
      };
    }
  }
  const filter = args.status as PlanArtifactStatus | undefined;
  const row = await getLatestPlanArtifact(sessionId, filter);
  if (!row) {
    // `status` is a real filter now, so a miss means "none with that status" —
    // which is NOT the same as "no plan". Saying the latter would hand the model
    // a contradiction (a plan is on screen, the tool denies it exists), and
    // reacting to exactly that contradiction is what made a model rewrite a
    // finished plan and destroy its history.
    if (filter) {
      const latest = await getLatestPlanArtifact(sessionId);
      if (latest) {
        return {
          success: true,
          content: null,
          message: `No plan with status "${filter}" — this session's plan is "${latest.planStatus}" (planId: ${latest.id}). Call plan({operation:"read"}) without a status to read it.`,
        };
      }
    }
    return { success: true, content: null, message: "No plan in this session yet." };
  }
  return {
    success: true,
    planId: row.id,
    // The plan's name, so a resumed turn knows WHICH plan it is working on
    // rather than having to infer it from the body.
    title: row.title,
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
  // A title is required to CREATE a plan, and only to create one — a rewrite of
  // an existing plan does not rename it.
  //
  // Enforced here rather than through the schema's `required` array because that
  // array is tool-wide: adding "title" to it would reject every
  // plan({operation:"read"}) / set_status / update_step call before the handler
  // ran. Property-level `required: true` is no better — normalize-tool-schema
  // hoists it into the same tool-wide array for the provider. This mirrors the
  // per-operation checks already used for `content` above and `reason` on
  // update_step, and returns a retryable tool result rather than a guard
  // envelope.
  if (!targetId && !args.title?.trim()) {
    return {
      success: false,
      error:
        "A `title` is required when creating a plan — a short imperative name for it (e.g. \"Fix cross-window sandbox mode\"), not a section heading like \"Goal\". Retry with title set.",
    };
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
    title: row.title,
  }, args._ownerWindowId);
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
  const resolved = planIdOrFailure(
    await resolvePlanId(args),
    "No plan to update — create one with plan({ operation: 'write' }) first.",
  );
  if (resolved.failure) return resolved.failure;
  const planId = resolved.id;
  const row = await setPlanArtifactStatus(planId, next);
  if (!row) return { success: false, error: "Plan not found." };
  broadcastPlanArtifactUpdated({
    planId: row.id,
    sessionId: row.sessionId,
    content: row.content,
    planStatus: row.planStatus,
    title: row.title,
  }, args._ownerWindowId);
  return {
    success: true,
    planId: row.id,
    planStatus: row.planStatus,
    marker: planArtifactMarker(row.id),
    // See the note in updateStep: `success` alone is not a recognisable tool
    // result, so an echoed copy of this leaked into the visible reply as raw JSON.
    message: `Plan status set to "${row.planStatus}".`,
  };
}

/**
 * Compact one-line checklist for the update_step not-found error — carries the
 * state the model needs to self-correct in ONE follow-up call (no plan(read)
 * round-trip, which only strong models think to do). Capped for token safety.
 */
function formatStepsForError(steps: PlanChecklistStep[]): string {
  const MARK: Record<PlanStepState, string> = {
    todo: " ",
    in_progress: "~",
    done: "x",
    blocked: "!",
    external: "@",
  };
  const shown = steps
    .slice(0, 20)
    .map((s) => `${s.index}.[${MARK[s.state] ?? " "}] ${s.text.slice(0, 60)}`);
  const more = steps.length > 20 ? ` …and ${steps.length - 20} more` : "";
  return shown.join("; ") + more;
}

async function updateStep(args: PlanToolArgs) {
  const allowed: PlanStepState[] = [
    "todo",
    "in_progress",
    "done",
    "blocked",
    "external",
  ];
  if (!allowed.includes(args.state as PlanStepState)) {
    return {
      success: false,
      error:
        "state must be one of: in_progress, done, todo, blocked, external.",
    };
  }
  if (args.step_index == null && !args.step_text?.trim()) {
    return {
      success: false,
      error: "Provide step_index (1-based) or step_text to identify the step.",
    };
  }
  // `external` ends the turn's obligation for this step, so it must not be free.
  // Without a required reason it is a silent escape hatch — and the user is left
  // with a step marked "yours" and no idea what to do. The reason is also the only
  // thing that makes abuse visible in the logs.
  const externalReason = args.reason?.trim();
  if (args.state === "external" && !externalReason) {
    return {
      success: false,
      error:
        "state 'external' requires `reason` — one line on what the USER has to do (e.g. \"rotate the signing key in the dashboard; no cert on this machine\"). " +
        "If you're stuck rather than handing it over, use state 'blocked' instead.",
    };
  }
  const resolvedPlan = planIdOrFailure(
    await resolvePlanId(args),
    "No plan to update — create one with plan({ operation: 'write' }) first.",
  );
  if (resolvedPlan.failure) return resolvedPlan.failure;
  const planId = resolvedPlan.id;
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
    externalReason,
  );
  if (!result.step) {
    const steps = parsePlanChecklist(row.content);
    // A miss used to return success:false into silence, and nothing anywhere
    // counted it — which is why diagnosing one took reading three DB rows.
    //
    // It matters because of what happens NEXT: the completion gate holds the
    // turn open on the unticked step, and the error below (correctly) offers
    // "rewrite the whole plan" as the way out. The model takes it, and the
    // record of what was actually done is gone. So the miss is the first domino
    // and it has to be visible.
    //
    // Matching is `text.includes(needle)`, one direction, no normalisation — so
    // a paraphrase, a longer description, or a character the model can't
    // reproduce byte-exactly (backticks, ×, µ, emoji) all miss. Log the needle
    // to learn WHICH of those it is before choosing a fix.
    logger.warn(
      `[plan] update_step found no match in plan ${planId} — ` +
        `step_index=${args.step_index ?? "none"} step_text=${JSON.stringify(args.step_text ?? null)} ` +
        `(${steps.length} step(s) in plan)`,
    );
    return {
      success: false,
      error:
        steps.length === 0
          ? "The plan has no checklist steps yet — rewrite it with operation:'write' using numbered '1. [ ] …' items."
          : `Step not found in plan checklist. Current steps: ${formatStepsForError(steps)}. ` +
            "Retry with step_index (the number shown above) — that is exact. Or step_text: a distinctive phrase " +
            "COPIED from the step, not paraphrased. Rewriting the whole plan with operation:'write' also works, but it " +
            "loses the record of what was already marked, so try the two precise options first.",
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
    title: updated.title,
  }, args._ownerWindowId);
  // Refresh the in-context ledger for the rest of THIS turn; without it the
  // step-0 snapshot keeps asserting stale counts for every later step.
  markPlanLedgerDirty(args.chatId, updated.content);
  const steps = parsePlanChecklist(updated.content);
  const done = steps.filter((s) => s.state === "done").length;
  const actionable = steps.filter((s) => isActionableStepState(s.state)).length;
  if (args.state === "external") {
    // Logged for the same reason the update_step MISS is logged below: `external`
    // releases the completion gate, so if a model starts using it to dodge work
    // this line is the only place that shows it.
    logger.info(
      `[plan] step ${result.step?.index ?? "?"} marked EXTERNAL in plan ${planId} — ` +
        `reason=${JSON.stringify(externalReason ?? null)} ` +
        `(${actionable} actionable step(s) left)`,
    );
  }
  const progress =
    `${done}/${steps.length} steps done` +
    (actionable === 0 ? ", none left for you" : `, ${actionable} left for you`);
  return {
    success: true,
    planId: updated.id,
    step: result.step,
    progress,
    // `message` is REQUIRED, not decoration: isToolResultEnvelopeObject
    // (answer-display.ts:164) only recognises a tool result when `success` is
    // accompanied by one of result/error/message/cost. Without it this shape was
    // unrecognised, so a model that echoed it into its visible reply had the raw
    // JSON rendered to the user verbatim instead of stripped. It also gives the
    // tool card something to say beyond "Done".
    message:
      `Step ${result.step?.index ?? ""} → ${result.step?.state ?? "updated"} (${progress}).`.replace(
        "  ",
        " ",
      ) +
      // Say it explicitly at the moment it becomes true. The gate no longer nudges
      // here, so this result is where the model learns it may stop.
      (actionable === 0
        ? " Nothing actionable remains — verify what you did, tell the user what's theirs, and end your turn."
        : ""),
  };
}

async function appendStep(args: PlanToolArgs) {
  if (!args.step_text?.trim()) {
    return { success: false, error: "step_text is required for operation 'append_step'." };
  }
  const resolvedAppend = planIdOrFailure(
    await resolvePlanId(args),
    "No plan to append to — create one with plan({ operation: 'write' }) first.",
  );
  if (resolvedAppend.failure) return resolvedAppend.failure;
  const planId = resolvedAppend.id;
  const row = await appendStepToPlanArtifact(planId, args.step_text);
  if (!row) return { success: false, error: "Plan not found." };
  broadcastPlanArtifactUpdated({
    planId: row.id,
    sessionId: row.sessionId,
    content: row.content,
    planStatus: row.planStatus,
    title: row.title,
  }, args._ownerWindowId);
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
    "'write' (create OR update the plan markdown — the CANONICAL way to update progress when several steps changed or you're unsure of numbering: re-emit the full plan with updated [x]/[~]/[!] marks, which is always safe and cannot miss. Include the returned marker comment in your reply so the card renders; pass planId to update a specific plan. " +
    "When CREATING a plan you must also pass `title` — a short imperative name for this plan, shown as its heading in the UI and how you tell it apart from other plans in the session. Do not use a section heading like \"Goal\" or \"Overview\"), " +
    "'read' (latest plan, or by planId / title / status filter — re-read before continuing if the user may have edited the plan), " +
    "'set_status' (plan_status: plan → building → built), " +
    "'update_step' (convenience for marking ONE step: state in_progress|done|todo|blocked|external + step_text (preferred — a unique substring of the step) or step_index. " +
    "Use 'external' for a step only the USER can do — a dashboard action, a purchase, hardware you don't have, a manual check — with a required `reason` saying what they must do; you are then DONE with that step and must not re-attempt it. " +
    "Use 'blocked' when you tried and are stuck, with the reason in your reply. Neither state holds the turn open, so once no step is todo/in_progress you should verify your work, say what's left for the user, and finish. " +
    "(Use ask_user instead when you need an answer to CONTINUE right now; 'external' is for handing a step over and moving on.)), " +
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
      // ORDER MATTERS for weak models. `simplifyToolParametersForProfile`
      // (routing/model-capability-profile.ts) keeps the top-level `required`
      // array plus only the FIRST THREE optional properties, in declaration
      // order, for any model on a "simplified" schema profile. `title` used to
      // sit fifth, behind workspaceSessionId/planId/status — so the models most
      // in need of being told to name their plan never saw the field at all.
      // content + title + planId is the write path plus plan targeting.
      content: {
        type: "string",
        description: "write: full markdown plan body",
        required: false,
      },
      title: {
        type: "string",
        description:
          "write: REQUIRED when creating a plan. A short imperative name for THIS plan, so it can be told apart from other plans in the same session (e.g. \"Fix cross-window sandbox mode\"). Not a section heading, not \"Goal\", not a restatement of the request. " +
          "On every OTHER operation title instead ADDRESSES a plan by name, so you can say which plan you mean without carrying its id. planId wins if you pass both; if two plans share the title the call fails and names both ids.",
        required: false,
      },
      planId: {
        type: "string",
        description: "Plan artifact id — optional for all ops; when omitted the session's latest plan is used.",
        required: false,
      },
      workspaceSessionId: stringParam("Workspace session id (auto-injected)"),
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
        description:
          "update_step: one of in_progress, done, todo, blocked, external (external = only the user can do it; requires reason)",
        required: false,
      },
      reason: {
        type: "string",
        description:
          "update_step + state:'external' (REQUIRED there): one line on what the user has to do",
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
