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

ToolRegistry.register({
  name: "list_sessions",
  description:
    "The user's other Atlarix sessions on this machine (CLI or app), for send_message.",
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
    const lines = rows.map(
      (r) =>
        `- ${r.name} (id ${r.sessionId.startsWith("pending-") ? r.sessionId : r.sessionId.slice(0, 8)}, ${r.surface === "cli" ? "CLI" : "app"}, ${r.busy ? "busy" : "idle"}) — ${r.workspace || "no workspace"}`,
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
    return {
      success: true,
      text: `Sent to ${target.row.name} (${target.row.surface === "cli" ? "CLI" : "app"}, ${target.row.busy ? "busy: it reads it at its next step" : "idle: it starts a turn with it"}).${replyNote}`,
    };
  },
});
