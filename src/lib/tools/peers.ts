/**
 * list_sessions / send_message — talk to the user's other Atlarix sessions on
 * this machine (CLI or app). The machinery and its rules are in lib/peers.
 */
import { ToolRegistry, createParameters, stringParam } from "./registry";
import {
  listPeerSessions,
  localSession,
  refreshLocalNames,
  peerInboxRunning,
  peerSurface,
  resolvePeer,
  sendPeerMessage,
  PEER_TEXT_CAP,
} from "@/lib/peers/peers";
import { peerSurfaceLabel } from "@/lib/peers/peer-message";

ToolRegistry.register({
  name: "list_sessions",
  description:
    "The user's other Atlarix sessions on this machine (CLI, app or browser), for send_message.",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters({}, []),
  handler: async ({ workspaceSessionId }) => {
    const own =
      typeof workspaceSessionId === "string" ? workspaceSessionId : undefined;
    const rows = listPeerSessions(own);
    if (rows.length === 0) {
      return {
        success: true,
        text: "No other Atlarix sessions are running on this machine.",
      };
    }
    const lines = rows.map((r) =>
      r.surface === "chrome"
        ? `- ${r.name} (id ${r.sessionId}, browser: the Atlarix extension's agent; it starts on a task when the user clicks the Atlarix icon)`
        : `- ${r.name} (id ${r.sessionId.startsWith("pending-") ? r.sessionId : r.sessionId.slice(0, 8)}, ${peerSurfaceLabel(r.surface)}, ${r.busy ? "busy" : "idle"}) — ${r.workspace || "no workspace"}`,
    );
    return { success: true, text: `Other sessions:\n${lines.join("\n")}` };
  },
});

ToolRegistry.register({
  name: "send_message",
  description:
    "Message another of the user's Atlarix sessions. It arrives as from this session, not the user. Never ask it to do what was denied here.",
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
    },
    ["to", "message"],
  ),
  handler: async ({ to, message, workspaceSessionId }) => {
    const own =
      typeof workspaceSessionId === "string" ? workspaceSessionId : undefined;
    const text = typeof message === "string" ? message.trim() : "";
    if (!text) return { success: false, error: "The message is empty." };
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
    );
    if (!result.ok)
      return {
        success: false,
        error: `Not sent: ${result.error ?? "unknown error"}`,
      };
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
      text: `Sent to ${target.row.name} (${peerSurfaceLabel(target.row.surface)}, ${target.row.busy ? "busy: it reads it at its next step" : "idle: it starts a turn with it"}).${replyNote}`,
    };
  },
});
