/**
 * The window's side of one session setting another's mode and/or model
 * (item 9): main already checked it and stored the mode on the session. The
 * chat's next turns run on the model (until you pick one), the open session
 * takes the mode, and the chat shows who changed what.
 */
import { getDefaultStore } from "jotai";
import { peerModelByChatIdAtom, peerSettingsNoticeByChatIdAtom } from "@/atoms/chatAtoms";
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
    if (p.mode && store.get(activeWorkspaceSessionIdAtom) === p.sessionId) {
      store.set(activeSessionWorkModeAtom, p.mode);
    }
    store.set(peerSettingsNoticeByChatIdAtom, (prev) => new Map(prev).set(p.chatId, p.notice));
  });
}
