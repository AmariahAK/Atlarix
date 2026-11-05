/**
 * list_sessions / send_message — talk to the user's other Atlarix sessions on
 * this machine (CLI or app). The machinery and its rules are in lib/peers.
 */
import { ToolRegistry, booleanParam, createParameters, stringParam } from "./registry";
import {
  endedText,
  filesChangedText,
  latestReply,
  listPeerSessions,
  localSession,
  refreshLocalNames,
  peerInboxRunning,
  peerSurface,
  resolvePeer,
  sendPeerMessage,
  turnRecordOf,
  PEER_TEXT_CAP,
} from "@/lib/peers/peers";
import { peerSurfaceLabel } from "@/lib/peers/peer-message";
import { MODE_NAMES, modelNames, parseMode, parsePlanAction, shortModelList } from "@/lib/peers/session-settings";

/** Describe a session's pending state for a reviewer (0aa). */
async function pendingStateText(sessionId: string): Promise<string> {
  const { getLatestPlanArtifact } = await import("@/lib/plans/plan-artifacts");
  const parts: string[] = [];
  // Pending permission approvals, from the registry: the asker may be another process.
  const { listPeerSessions } = await import("@/lib/peers/peers");
  const s = listPeerSessions().find((r) => r.sessionId === sessionId);
  if (s?.hasApproval) {
    const approvals = s.pendingApprovals ?? [];
    if (approvals.length === 0) {
      // Fallback: hasApproval is set but no details were stored (older CLI).
      parts.push("This session has one or more permission requests waiting for an answer.\n(No details available — the session may be running an older version.)");
    } else {
      const lines = approvals.map((a, i) => {
        const risk = a.isDangerous || a.systemScope ? " [HIGH-RISK]" : "";
        const cwd = a.cwd ? `\n  cwd: ${a.cwd}` : "";
        const detail = a.detail ? `\n  detail:\n${a.detail.replace(/^/gm, "    ")}` : "";
        return `${i + 1}. operationId: ${a.operationId}${risk}\n  type: ${a.operation ?? "unknown"}\n  request: ${a.summary}${cwd}${detail}`;
      });
      parts.push(`Permission request${approvals.length > 1 ? "s" : ""} waiting for an answer:\n${lines.join("\n")}`);
    }
  }
  // Plan awaiting approval.
  const plan = await getLatestPlanArtifact(sessionId, "plan").catch(() => null);
  if (plan) {
    parts.push(`Plan awaiting approval: "${plan.title ?? "Plan"}"\n${plan.content}`);
  }
  return parts.length
    ? parts.join("\n\n")
    : "No pending requests or plans found for this session.";
}

ToolRegistry.register({
  name: "list_sessions",
  description:
    "The user's other Atlarix sessions on this machine (CLI, app or browser), for send_message. When a session shows 'approval waiting', its operationId(s) are listed so you can pass them to send_message({approval: operationId}); pending_of shows what each request does.",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      plan_of: stringParam("A session's name or id: also show its latest plan, in full."),
      result_of: stringParam(
        "A session's name or id: also show its latest finished turn: how it ended, its reply and the files it changed.",
      ),
      pending_of: stringParam(
        "A session's name or id: also show its pending permission requests in full: the command, or the change and its diff.",
      ),
    },
    [],
  ),
  handler: async ({ workspaceSessionId, plan_of, result_of, pending_of }) => {
    const own =
      typeof workspaceSessionId === "string" ? workspaceSessionId : undefined;
    const rows = listPeerSessions(own);
    if (rows.length === 0) {
      return {
        success: true,
        text: "No other Atlarix sessions are running on this machine.",
      };
    }
    // A plan awaiting approval, for send_message's `plan` (item 11).
    const { getLatestPlanArtifact } = await import("@/lib/plans/plan-artifacts");
    const toReview = new Map<string, string>();
    for (const r of rows) {
      if (r.surface === "chrome" || r.sessionId.startsWith("pending-")) continue;
      const p = await getLatestPlanArtifact(r.sessionId, "plan").catch(() => null);
      if (p) toReview.set(r.sessionId, p.title ?? "Plan");
    }
    const lines = rows.map((r) =>
      r.surface === "chrome"
        ? `- ${r.name} (id ${r.sessionId}, browser: the Atlarix extension's agent; it starts on a task when the user clicks the Atlarix icon)`
        : `- ${r.name} (id ${r.sessionId.startsWith("pending-") ? r.sessionId : r.sessionId.slice(0, 8)}, ${peerSurfaceLabel(r.surface)}, ${r.busy ? "busy" : r.new ? "new" : "idle"}${settingsOf(r)}${toReview.has(r.sessionId) ? ` · plan to review: ${toReview.get(r.sessionId)}` : ""}${r.hasApproval ? approvalWaitingText(r) : ""}) — ${r.workspace || "no workspace"}`,
    );
    let planText = "";
    if (typeof plan_of === "string" && plan_of.trim()) {
      const found = resolvePeer(plan_of.trim(), own);
      if ("error" in found) planText = `\n\n${found.error}`;
      else {
        const p = await getLatestPlanArtifact(found.row.session_id).catch(() => null);
        planText = p
          ? `\n\nPlan of ${found.row.name} (${p.planStatus === "plan" ? "awaiting approval" : p.planStatus}): ${p.title ?? "Plan"}\n${p.content}`
          : `\n\n${found.row.name} has no plan.`;
      }
    }
    const resultText =
      typeof result_of === "string" && result_of.trim()
        ? `\n\n${await resultOf(result_of.trim(), own)}`
        : "";
    let pendingText = "";
    if (typeof pending_of === "string" && pending_of.trim()) {
      const found = resolvePeer(pending_of.trim(), own);
      if ("error" in found) pendingText = `\n\n${found.error}`;
      else {
        // Its words (commands, diffs), framed as data: that session's, not the user's.
        const { wrapUntrustedData } = await import("@/lib/streaming/untrusted-data");
        pendingText = `\n\nPending requests of ${found.row.name}:\n${wrapUntrustedData(`session:${found.row.name}`, await pendingStateText(found.row.session_id))}`;
      }
    }
    // What send_message's `model` may be: only what this user has set up.
    const { settableModelOptions } = await import("@/cli/agent/models");
    const models = modelNames(await settableModelOptions().catch(() => [])).map((n) => n.name);
    return {
      success: true,
      text: `Other sessions:\n${lines.join("\n")}${models.length ? `\nModels you can set: ${shortModelList(models)}` : ""}${planText}${resultText}${pendingText}`,
    };
  },
});

/** Characters of another session's reply shown by `result_of`. */
export const RESULT_REPLY_CAP = 4000;

/**
 * Another session's latest finished turn: how it ended and when, its reply
 * (bounded) and the files that turn changed. Its words, framed as data: they
 * are that session's, not the user's.
 */
async function resultOf(to: string, own: string | undefined): Promise<string> {
  const found = resolvePeer(to, own);
  if ("error" in found) return found.error;
  const row = found.row;
  if (row.surface === "chrome") {
    return `${row.name} is the browser agent: its results come back here as messages.`;
  }
  const turn = turnRecordOf(row);
  const reply = latestReply(row.session_id, turn?.startedAt);
  if (!turn && !reply) return `${row.name} has not finished a turn yet.`;
  const ended = turn
    ? endedText(turn.outcome, turn.errorKind)
    : reply!.status === "interrupted"
      ? "stopped"
      : reply!.status === "waiting"
        ? "waiting for the user"
        : "done";
  const at = new Date(turn?.endedAt ?? reply!.at).toLocaleString();
  const head = `${row.busy ? `${row.name} is still working. Its last finished turn` : `Latest turn of ${row.name}`}: ${ended}, ${at}.`;
  if (!reply) return `${head}\nNo reply was saved for it.`;

  const { finalAnswerText } = await import("@/lib/chat/assistant-message-parts");
  const full = finalAnswerText(reply.content).trim();
  const shown =
    full.length > RESULT_REPLY_CAP
      ? `${full.slice(0, RESULT_REPLY_CAP)}…\n[${RESULT_REPLY_CAP.toLocaleString("en-US")} of ${full.length.toLocaleString("en-US")} characters; ask ${row.name} for the rest with send_message.]`
      : full || "(no text)";
  const files = await filesChangedText(row.workspace, reply.snapshotTurnId);
  const { wrapUntrustedData } = await import("@/lib/streaming/untrusted-data");
  return `${head}\nFiles changed: ${files || "none"}.\nIts reply (its words, not the user's):\n${wrapUntrustedData(`session:${row.name}`, shown)}`;
}

/**
 * " · approval waiting — operationId: abc123 (run_command)" — or multiple IDs.
 * Gives a supervisor enough to call send_message({approval: operationId})
 * without a separate review:true round-trip.
 *
 * Exported for tests only; use via the list_sessions handler output in production.
 */
export function approvalWaitingText(r: { pendingApprovals?: { operationId: string; operation?: string }[] }): string {
  const approvals = r.pendingApprovals;
  if (!approvals || approvals.length === 0) {
    // Older CLI: no detail stored, just flag it.
    return " · approval waiting";
  }
  const ids = approvals
    .map((a) => `${a.operationId}${a.operation ? ` (${a.operation})` : ""}`)
    .join(", ");
  return ` · approval waiting — operationId: ${ids}`;
}

/** " · Build · Atlarix Auto": its mode, and its model when known. */
function settingsOf(r: { mode?: string; model?: string }): string {
  const mode = parseMode(r.mode);
  return `${mode ? ` · ${MODE_NAMES[mode]}` : ""}${r.model ? ` · ${r.model}` : ""}`;
}

ToolRegistry.register({
  name: "send_message",
  description:
    "Message another of the user's Atlarix sessions, set its mode or model (from list_sessions) from its next turn, and/or answer its plan. A message arrives as from this session, not the user. Never ask it to do what was denied here.",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      to: stringParam("Session name or id."),
      message: stringParam(
        "Plain text with the context it needs; it can't see this conversation.",
      ),
      mode: stringParam("Its mode from its next turn: build, explore, plan, debug or review."),
      model: stringParam("A model from list_sessions' list (its name as shown)."),
      plan: stringParam(
        "Its plan awaiting approval: approve (it starts building), reject (message says why) or update (plan_text replaces it).",
      ),
      plan_text: stringParam("The whole new plan, for plan: update."),
      notify_when_done: booleanParam("One notice here when its turn ends."),
      review: booleanParam(
        "Attach the target session's current pending state (permission requests, plan) to the message so the recipient can review and answer it. Only use when the user explicitly asks you to have another session review or approve something.",
      ),
      approval: stringParam(
        "Answer a pending permission request in the target session: its operationId (list_sessions pending_of shows what it does). Only when the user asked you to review that session's requests, and only as their instructions say.",
      ),
      approval_mode: stringParam(
        "How to answer: \"once\" (allow this time, default), \"change\" (refuse; message says what to do instead) or \"deny\" (refuse; message gives the reason).",
      ),
    },
    ["to"],
  ),
  handler: async ({ to, message, mode, model, plan, plan_text, notify_when_done, review, approval, approval_mode, workspaceSessionId }) => {
    const own =
      typeof workspaceSessionId === "string" ? workspaceSessionId : undefined;
    const text = typeof message === "string" ? message.trim() : "";
    const setMode = typeof mode === "string" && mode.trim() ? mode.trim() : undefined;
    const setModel = typeof model === "string" && model.trim() ? model.trim() : undefined;
    const planAction = typeof plan === "string" && plan.trim() ? plan.trim().toLowerCase() : undefined;
    const planBody = typeof plan_text === "string" ? plan_text.trim() : "";
    const doReview = review === true;
    const approvalId = typeof approval === "string" && approval.trim() ? approval.trim() : undefined;
    const approvalWord = typeof approval_mode === "string" ? approval_mode.trim().toLowerCase() : "";
    // "change" is a deny whose message says what to do instead: the asker reads it and redoes the step.
    const approvalModeVal = approvalWord === "deny" || approvalWord === "change" ? "deny" : "once";
    if (approvalWord === "change" && !text) {
      return { success: false, error: "approval_mode change needs a message saying what to change." };
    }
    if (!text && !setMode && !setModel && !planAction && !doReview && !approvalId) {
      return { success: false, error: "Nothing to send: give a message, a mode, a model, a plan answer, review:true, or an approval." };
    }
    if (planAction && !parsePlanAction(planAction)) {
      return { success: false, error: `No plan action "${plan}": approve, reject or update.` };
    }
    if (planAction === "reject" && !text) return { success: false, error: "A reject needs a message saying why." };
    if (planAction === "update" && !planBody) return { success: false, error: "update needs plan_text: the whole new plan." };
    // A notice is about a turn: only a message or an approval starts one.
    const notify = notify_when_done === true;
    if (notify && !text && planAction !== "approve") {
      return { success: false, error: "notify_when_done needs a message (or a plan approval) that starts a turn." };
    }
    if (setMode && !parseMode(setMode)) {
      return { success: false, error: `No mode "${setMode}": build, explore, plan, debug or review.` };
    }
    if (text.length > PEER_TEXT_CAP) {
      return {
        success: false,
        error: `The message is over ${PEER_TEXT_CAP} characters; send a summary and point at files instead.`,
      };
    }
    const target = resolvePeer(String(to ?? ""), own);
    if ("error" in target) return { success: false, error: target.error };
    if (own && target.row.session_id === own) {
      return { success: false, error: "That is this session." };
    }
    refreshLocalNames();
    const me = localSession(own);

    // review:true — attach the target's pending state to the outgoing message.
    let reviewText = "";
    if (doReview) {
      reviewText = await pendingStateText(target.row.session_id);
    }
    const fullText = [text, reviewText].filter(Boolean).join("\n\n");
    if (!fullText && !setMode && !setModel && !planAction && !approvalId) {
      return { success: false, error: "Nothing to send after building the review text." };
    }

    const result = await sendPeerMessage(
      target.row,
      {
        sessionId: own ?? "unknown",
        name: me?.name ?? "another session",
        surface: peerSurface(),
        workspace: me?.workspace ?? "",
      },
      fullText,
      setMode || setModel || planAction || approvalId
        ? {
            ...(setMode ? { mode: setMode } : {}),
            ...(setModel ? { model: setModel } : {}),
            ...(planAction ? { plan: planAction, ...(planBody ? { planText: planBody } : {}) } : {}),
            ...(approvalId ? { approval: { operationId: approvalId, mode: approvalModeVal } } : {}),
          }
        : undefined,
      // A browser's result already comes back as a message.
      { notify: notify && target.row.surface !== "chrome" },
    );
    if (!result.ok)
      return {
        success: false,
        error: `Not sent: ${result.error ?? "unknown error"}`,
      };
    // Said only when the other side took it on (an older Atlarix ignores it).
    const noticeNote = result.notify ? " Notice when its turn ends." : "";
    // A change alone: say what it now shows, rather than "it starts a turn".
    if (!fullText) return { success: true, text: `${target.row.name}: ${result.applied ?? "changed"}${noticeNote}` };
    const replyNote = peerInboxRunning()
      ? ""
      : " (This session has no inbox, so it cannot be replied to.)";
    if (target.row.surface === "chrome") {
      return {
        success: true,
        text: `Delivered to ${target.row.name}. It starts when the user clicks the Atlarix icon in ${target.row.name} (the badge shows it waiting); its result comes back here as a message.${replyNote}`,
      };
    }
    return {
      success: true,
      text: `Sent to ${target.row.name} (${peerSurfaceLabel(target.row.surface)}, ${target.row.busy ? "busy: it reads it at its next step" : result.waits ? "idle: it reads it with the user's next prompt there" : "idle: it starts a turn with it"}).${result.applied ? ` ${result.applied}` : ""}${noticeNote}${replyNote}`,
    };
  },
});
