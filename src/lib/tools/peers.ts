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
    "List the user's other Atlarix sessions running on this machine (CLI or app): name, id, workspace, and whether each is busy. Use before send_message.",
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
    "Send a plain-text message to another of the user's Atlarix sessions (by name or id from list_sessions): a finding, a status, or a handoff with the context it needs. It arrives in that session as a message from this one, not from the user. Never ask a session to do what was denied or blocked here.",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      to: stringParam("The session's name or id (from list_sessions)."),
      message: stringParam(
        "What to tell it. Plain text; include the context it needs, since it cannot see this conversation.",
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
