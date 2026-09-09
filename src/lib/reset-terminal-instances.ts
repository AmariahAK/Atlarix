import { getDefaultStore } from "jotai";
import {
  activeTerminalInstanceByScopeAtom,
  terminalAgentOpMapByScopeAtom,
  terminalInstancesByScopeAtom,
} from "@/atoms/terminalInstancesAtoms";
import { IpcClient } from "@/ipc/ipc_client";

/** Clears all terminal tabs/output when the user starts a new chat. */
export function resetTerminalInstancesForNewChat(): void {
  const store = getDefaultStore();
  store.set(terminalInstancesByScopeAtom, {});
  store.set(activeTerminalInstanceByScopeAtom, {});
  store.set(terminalAgentOpMapByScopeAtom, {});
  void IpcClient.getInstance()
    .clearAllTerminalInstances()
    .catch(() => {
      /* main may be unavailable in tests */
    });
}
