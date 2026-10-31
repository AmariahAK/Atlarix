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

ToolRegistry.register({
  name: "list_sessions",
  description:
    "The user's other Atlarix sessions on this machine (CLI, app or browser), for send_message.",
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
    },
    [],
  ),
  handler: async ({ workspaceSessionId, plan_of, result_of }) => {
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
        : `- ${r.name} (id ${r.sessionId.startsWith("pending-") ? r.sessionId : r.sessionId.slice(0, 8)}, ${peerSurfaceLabel(r.surface)}, ${r.busy ? "busy" : r.new ? "new" : "idle"}${settingsOf(r)}${toReview.has(r.sessionId) ? ` · plan to review: ${toReview.get(r.sessionId)}` : ""}) — ${r.workspace || "no workspace"}`,
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
    // What send_message's `model` may be: only what this user has set up.
    const { settableModelOptions } = await import("@/cli/agent/models");
    const models = modelNames(await settableModelOptions().catch(() => [])).map((n) => n.name);
    return {
      success: true,
      text: `Other sessions:\n${lines.join("\n")}${models.length ? `\nModels you can set: ${shortModelList(models)}` : ""}${planText}${resultText}`,
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
    },
    ["to"],
  ),
  handler: async ({ to, message, mode, model, plan, plan_text, notify_when_done, workspaceSessionId }) => {
    const own =
      typeof workspaceSessionId === "string" ? workspaceSessionId : undefined;
    const text = typeof message === "string" ? message.trim() : "";
    const setMode = typeof mode === "string" && mode.trim() ? mode.trim() : undefined;
    const setModel = typeof model === "string" && model.trim() ? model.trim() : undefined;
    const planAction = typeof plan === "string" && plan.trim() ? plan.trim().toLowerCase() : undefined;
    const planBody = typeof plan_text === "string" ? plan_text.trim() : "";
    if (!text && !setMode && !setModel && !planAction) {
      return { success: false, error: "Nothing to send: give a message, a mode, a model or a plan answer." };
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
    const result = await sendPeerMessage(
      target.row,
      {
        sessionId: own ?? "unknown",
        name: me?.name ?? "another session",
        surface: peerSurface(),
        workspace: me?.workspace ?? "",
      },
      text,
      setMode || setModel || planAction
        ? {
            ...(setMode ? { mode: setMode } : {}),
            ...(setModel ? { model: setModel } : {}),
            ...(planAction ? { plan: planAction, ...(planBody ? { planText: planBody } : {}) } : {}),
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
    if (!text) return { success: true, text: `${target.row.name}: ${result.applied ?? "changed"}${noticeNote}` };
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
      text: `Sent to ${target.row.name} (${peerSurfaceLabel(target.row.surface)}, ${target.row.busy ? "busy: it reads it at its next step" : result.waits ? "idle: it reads it at its next turn" : "idle: it starts a turn with it"}).${result.applied ? ` ${result.applied}` : ""}${noticeNote}${replyNote}`,
    };
  },
});
