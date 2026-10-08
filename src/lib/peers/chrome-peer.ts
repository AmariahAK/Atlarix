/**
 * The browser as a session (owner, 2026-10-08): the Atlarix extension's
 * side-panel agent, listed by `list_sessions` and reachable by `send_message`
 * like any CLI or app session.
 *
 * ══ WHY THE BRIDGE HOST SPEAKS FOR IT ══
 *
 * A session is a row in the shared database plus a socket that accepts its
 * messages (peers.ts). The extension has neither: it cannot read the database
 * and it cannot listen. The process that hosts the browser connection already
 * holds the one channel to it, so that process registers a session on the
 * browser's behalf and hands each message on with the bridge op `peer_deliver`.
 * The extension keeps it in an inbox and shows a badge; the user's click on the
 * Atlarix icon is what starts it — nothing here can open the side panel.
 *
 * Replies travel the other way as a bridge-v2 `ext-request` (`peer_send`). The
 * desktop writes the `from` itself, from this registration: the extension says
 * WHO to reply to and WHAT, never who it is, so it cannot pass itself off as
 * another session. The extension separately limits its replies to sessions
 * that sent it a task (its send_message tool).
 *
 * When the host process quits, its rows go with it; the browser reconnects to
 * the process that takes over, says hello again, and is registered there.
 */
import log from "electron-log";

import type { BridgeHello, BridgeServer } from "@/lib/bridge/server";
import type { PeerFrom } from "./peer-message";
import {
  PEER_TEXT_CAP,
  forgetLiveSession,
  listPeerSessions,
  noteLiveSession,
  resolvePeer,
  sendPeerMessage,
} from "./peers";

const logger = log.scope("peers");

/** How long the extension has to accept a delivery (it only files it). */
const DELIVER_TIMEOUT_MS = 10_000;

export function chromeSessionId(profileId: string): string {
  return `chrome-${profileId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`;
}

/** "Chrome", "Brave", "Edge" — what the user calls the browser. */
export function browserLabel(hello: BridgeHello): string {
  const b = (hello.browser ?? "").toLowerCase();
  if (b.includes("brave")) return "Brave";
  if (b.includes("edge")) return "Edge";
  return "Chrome";
}

function speaksPeers(hello: BridgeHello): hello is BridgeHello & { profileId: string } {
  return (hello.protocol ?? 1) >= 2 && typeof hello.profileId === "string" && hello.profileId.length >= 8;
}

/**
 * The three bridge callbacks that make a connected browser a session. `server`
 * is the bridge this process hosts.
 */
export function chromePeer(server: () => Pick<BridgeServer, "request"> | null) {
  // A profile can hold two connections for a moment (a reconnect lands before
  // the old one's close), so its session goes only when its last one does.
  const connections = new Map<string, Set<object>>();

  const fromOf = (hello: BridgeHello & { profileId: string }): PeerFrom => ({
    sessionId: chromeSessionId(hello.profileId),
    name: browserLabel(hello),
    surface: "chrome",
    workspace: "",
  });

  return {
    onHello(hello: BridgeHello, connection: object): void {
      if (!speaksPeers(hello)) return;
      const me = fromOf(hello);
      const { profileId } = hello;
      const open = connections.get(profileId) ?? new Set<object>();
      open.add(connection);
      connections.set(profileId, open);
      noteLiveSession({
        sessionId: me.sessionId,
        chatId: -1,
        name: me.name,
        workspace: "",
        surface: "chrome",
        deliver: async (id, from, text) => {
          const bridge = server();
          if (!bridge) return { ok: false, error: "the browser is not connected" };
          await bridge.request(
            "peer_deliver",
            { id, from, text },
            DELIVER_TIMEOUT_MS,
            { profileId },
          );
          return { ok: true };
        },
      });
    },

    onPeerGone(hello: BridgeHello, connection: object): void {
      if (!speaksPeers(hello)) return;
      const open = connections.get(hello.profileId);
      open?.delete(connection);
      if (open && open.size > 0) return;
      connections.delete(hello.profileId);
      forgetLiveSession(chromeSessionId(hello.profileId));
    },

    async onExtRequest(
      hello: BridgeHello,
      op: string,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      if (!speaksPeers(hello)) throw new Error("this browser has not identified itself");
      const me0 = fromOf(hello);
      if (op === "peer_list") {
        // The user's CLI and app sessions: what the browser's agent can message.
        // A workspace goes as its folder name only — the model needs to tell two
        // sessions apart, not where the user keeps their code.
        return {
          sessions: listPeerSessions(me0.sessionId)
            .filter((r) => r.surface !== "chrome")
            .map((r) => ({
              sessionId: r.sessionId,
              name: r.name,
              surface: r.surface,
              workspace: r.workspace.split(/[\\/]/).filter(Boolean).pop() ?? "",
              busy: r.busy,
            })),
        };
      }
      if (op !== "peer_send") throw new Error(`the desktop does not serve "${op}"`);
      const to = typeof args.to === "string" ? args.to.trim() : "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!to) throw new Error("say which session to send to");
      if (!text) throw new Error("the message is empty");
      if (text.length > PEER_TEXT_CAP) {
        throw new Error(`the message is over ${PEER_TEXT_CAP} characters`);
      }
      const me = fromOf(hello);
      const target = resolvePeer(to, me.sessionId);
      if ("error" in target) throw new Error(target.error);
      const result = await sendPeerMessage(target.row, me, text);
      if (!result.ok) throw new Error(result.error ?? "not delivered");
      logger.info(`${me.name} replied to ${target.row.name}`);
      return { sent: true, to: target.row.name };
    },
  };
}
