/**
 * Shared "+ workspace" flow for chat controls and home.
 */

import { getDefaultStore } from "jotai";
import {
  pendingWorkspaceAppIdAtom,
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import {
  bindChatToAppId,
  getChatBoundAppId,
  shouldDeferWorkspaceToNextChat,
} from "@/lib/chat-workspace-binding";
import { IpcClient } from "@/ipc/ipc_client";
import type { App } from "@/ipc/ipc_types";
import { toast } from "sonner";

export type OpenWorkspaceOptions = {
  apps: App[];
  refreshApps?: () => Promise<void>;
  activeChatId?: number | null;
  hasUserMessageInThread?: boolean;
};

async function importOrSelectApp(
  path: string,
  apps: App[],
  refreshApps?: () => Promise<void>,
): Promise<{ appId: number; name: string; path: string }> {
  const existingApp = apps.find((app) => app.path === path);
  if (existingApp) {
    return {
      appId: existingApp.id,
      name: existingApp.name,
      path: existingApp.path ?? path,
    };
  }

  const ipcRenderer = window.electron?.ipcRenderer;
  if (ipcRenderer?.invoke) {
    const limitCheck = (await ipcRenderer.invoke("auth:check-workspace-limit")) as {
      allowed?: boolean;
      reason?: string;
    };
    if (!limitCheck.allowed) {
      const { triggerUpgrade } = await import("@/hooks/useUpgrade");
      void triggerUpgrade();
      throw new Error(
        limitCheck.reason ?? "Upgrade to Pro for unlimited workspaces.",
      );
    }
  }

  const appName = path.split(/[/\\]/).pop() || "Workspace";
  const importResult = await IpcClient.getInstance().importApp({ path, appName });
  await refreshApps?.();
  return { appId: importResult.appId, name: appName, path };
}

/**
 * Open folder picker and attach workspace. Mid-chat chat-only threads get
 * `pendingWorkspaceAppId` only; workspace binds on the next new chat.
 */
export async function openWorkspaceFromDialog(
  options: OpenWorkspaceOptions,
): Promise<void> {
  const ipcRenderer = window.electron?.ipcRenderer;
  const result = (await ipcRenderer?.invoke?.("dialog:openDirectory")) as
    | { canceled?: boolean; filePaths?: string[] }
    | undefined;
  if (!result || result.canceled || !result.filePaths?.[0]) return;

  const path = result.filePaths[0];
  const { appId, name, appPath } = await importOrSelectApp(
    path,
    options.apps,
    options.refreshApps,
  );

  const store = getDefaultStore();
  const defer = shouldDeferWorkspaceToNextChat(
    options.activeChatId,
    options.hasUserMessageInThread ?? false,
  );

  if (defer) {
    store.set(pendingWorkspaceAppIdAtom, appId);
    store.set(selectedWorkspaceInfoAtom, { id: appId, name, path: appPath });
    toast.info("Workspace added — open a new chat to use it in this session.");
    return;
  }

  store.set(pendingWorkspaceAppIdAtom, null);
  store.set(selectedAppIdAtom, appId);
  store.set(selectedWorkspaceInfoAtom, { id: appId, name, path: appPath });

  if (options.activeChatId != null && getChatBoundAppId(options.activeChatId) === null) {
    bindChatToAppId(options.activeChatId, appId);
  }
}
