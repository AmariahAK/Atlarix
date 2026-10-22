/**
 * The window's side of one session setting another's mode and/or model
 * (item 9): main already checked it and stored the mode on the session. The
 * chat's next turns run on the model (until you pick one), the open session
 * takes the mode, and the chat shows who changed what.
 */
import { getDefaultStore } from "jotai";
import {
  type PeerNotice,
  peerModeByChatIdAtom,
  peerModelByChatIdAtom,
  peerSettingsNoticeByChatIdAtom,
} from "@/atoms/chatAtoms";
import { activeSessionWorkModeAtom, activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
import { IpcClient } from "@/ipc/ipc_client";

/** Once per window, at startup. Returns the unsubscribe. */
export function subscribeToPeerSessionSettings(): () => void {
  return IpcClient.getInstance().onPeerSessionSettings((p) => {
    const store = getDefaultStore();
    if (p.model) {
      const model = p.model;
      store.set(peerModelByChatIdAtom, (prev) => new Map(prev).set(p.chatId, model));
    }
    if (p.mode) {
      const mode = p.mode;
      store.set(peerModeByChatIdAtom, (prev) => new Map(prev).set(p.chatId, mode));
      if (store.get(activeWorkspaceSessionIdAtom) === p.sessionId) store.set(activeSessionWorkModeAtom, mode);
    }
    store.set(peerSettingsNoticeByChatIdAtom, (prev) => new Map(prev).set(p.chatId, noticeFor(p)));
  });
}

/**
 * A plan answer's line outlives the turn it starts: an approval starts the
 * build at once, which cleared it before anyone saw who approved (QA A13).
 * A mode or model line goes when the next turn starts, the one it was for.
 */
export function noticeFor(p: { notice: string; plan?: string }): PeerNotice {
  return { text: p.notice, keepTurns: p.plan ? 1 : 0 };
}

/** The line when a turn starts: gone, or kept one turn fewer. */
export function noticeAfterTurnStart(n: PeerNotice | undefined): PeerNotice | undefined {
  if (!n || n.keepTurns <= 0) return undefined;
  return { ...n, keepTurns: n.keepTurns - 1 };
}
