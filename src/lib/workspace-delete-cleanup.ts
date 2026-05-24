/**
 * Clear renderer state when a workspace is removed so hooks do not keep polling a stale app id.
 */

import { getDefaultStore } from "jotai";
import type { QueryClient } from "@tanstack/react-query";
import {
  currentAppAtom,
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";

export function clearDeletedWorkspaceClientState(
  deletedAppId: number,
  queryClient?: QueryClient,
): void {
  const store = getDefaultStore();
  const selectedAppId = store.get(selectedAppIdAtom);

  if (selectedAppId === deletedAppId) {
    store.set(selectedAppIdAtom, null);
    store.set(selectedWorkspaceInfoAtom, null);
    store.set(currentAppAtom, null);
    store.set(activeChatIdAtom, null);
    store.set(selectedChatIdAtom, null);
  }

  queryClient?.removeQueries({ queryKey: ["app", deletedAppId] });
}
