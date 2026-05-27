/**
 * Unified workspace open → session → ephemeral chat → IDE navigation.
 */

import { getDefaultStore } from "jotai";
import { basenameFromPath } from "@/lib/path-basename";
import type { NavigateOptions } from "@tanstack/react-router";
import { IpcClient } from "@/ipc/ipc_client";
import { attachWorkspaceToChat } from "@/lib/chat-workspace-binding";
import {
  activeWorkspaceSessionIdAtom,
  chatIdToSessionIdAtom,
  sessionIdToChatIdAtom,
  loadedSessionResumeAtom,
  workspaceSessionsRefreshAtom,
} from "@/atoms/sessionAtoms";
import {
  activeChatIdAtom,
  chatMessagesByIdAtom,
  selectedChatIdAtom,
} from "@/atoms/chatAtoms";
import {
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import { loadedSessionTruncatedAtom } from "@/atoms/sessionAtoms";
import { pushRecentWorkspace } from "@/lib/workspace-recents";
import { showError } from "@/lib/toast";

export type OpenWorkspaceFolderResult = {
  appId: number;
  chatId: number;
  sessionId: string;
  path: string;
  name: string;
};

export type StartNewWorkspaceConversationOptions = {
  workspaceId: number;
  workspaceName?: string;
  workspacePath?: string;
  navigate?: (opts: NavigateOptions) => void;
  refreshApps?: () => Promise<void>;
};

/**
 * Start a fresh ephemeral chat + workspace session without leaving the IDE.
 * Keeps selectedAppId set so the home route does not show the welcome launcher.
 */
export async function startNewWorkspaceConversation(
  options: StartNewWorkspaceConversationOptions,
): Promise<number | null> {
  const { workspaceId } = options;
  try {
    const ipc = IpcClient.getInstance();
    const app = await ipc.getApp(workspaceId);
    if (app.pathExists === false) {
      showError("Workspace folder not found. Remove it from the list and try again.");
      return null;
    }

    const name = options.workspaceName ?? app.name ?? "Workspace";
    const workspacePath = options.workspacePath ?? app.path ?? "";

    const session = await ipc.createWorkspaceSession(workspaceId);
    const chatId = await ipc.createChat(workspaceId);
    const store = getDefaultStore();

    attachWorkspaceToChat(chatId, workspaceId, {
      name,
      path: workspacePath || undefined,
    });

    store.set(selectedAppIdAtom, workspaceId);
    store.set(selectedWorkspaceInfoAtom, {
      id: workspaceId,
      name,
      path: workspacePath,
    });
    store.set(activeWorkspaceSessionIdAtom, session.id);
    store.set(loadedSessionResumeAtom, false);
    store.set(loadedSessionTruncatedAtom, false);
    store.set(sessionIdToChatIdAtom, (prev) => {
      const next = new Map(prev);
      next.set(session.id, chatId);
      return next;
    });
    store.set(chatIdToSessionIdAtom, (prev) => {
      const next = new Map(prev);
      next.set(chatId, session.id);
      return next;
    });
    store.set(chatMessagesByIdAtom, (prev) => {
      const next = new Map(prev);
      next.set(chatId, []);
      return next;
    });
    store.set(activeChatIdAtom, chatId);
    store.set(selectedChatIdAtom, chatId);
    store.set(workspaceSessionsRefreshAtom, (n) => n + 1);

    options.navigate?.({ to: "/" });
    await options.refreshApps?.();

    return chatId;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showError(msg);
    console.error("Failed to start new workspace conversation:", e);
    return null;
  }
}

export type OpenWorkspaceFolderOptions = {
  /** Local filesystem path or atlarix-remote:// URI */
  folderPath: string;
  appName?: string;
  installCommand?: string | null;
  startCommand?: string | null;
  navigate?: (opts: NavigateOptions) => void;
  refreshApps?: () => Promise<void>;
};

async function resolveSessionAndChat(
  workspaceAppId: number,
): Promise<{ sessionId: string; chatId: number }> {
  const ipc = IpcClient.getInstance();
  const store = getDefaultStore();
  const sessionToChat = store.get(sessionIdToChatIdAtom);

  const sessions = await ipc.listWorkspaceSessions(workspaceAppId);
  const sorted = [...sessions].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  if (sorted.length > 0) {
    const sessionId = sorted[0].id;
    const existingChatId = sessionToChat.get(sessionId);
    if (existingChatId != null) {
      return { sessionId, chatId: existingChatId };
    }
    const chatId = await ipc.createChat(workspaceAppId);
    store.set(sessionIdToChatIdAtom, (prev) => {
      const next = new Map(prev);
      next.set(sessionId, chatId);
      return next;
    });
    store.set(chatIdToSessionIdAtom, (prev) => {
      const next = new Map(prev);
      next.set(chatId, sessionId);
      return next;
    });
    return { sessionId, chatId };
  }

  const session = await ipc.createWorkspaceSession(workspaceAppId);
  const chatId = await ipc.createChat(workspaceAppId);
  store.set(sessionIdToChatIdAtom, (prev) => {
    const next = new Map(prev);
    next.set(session.id, chatId);
    return next;
  });
  store.set(chatIdToSessionIdAtom, (prev) => {
    const next = new Map(prev);
    next.set(chatId, session.id);
    return next;
  });
  return { sessionId: session.id, chatId };
}

/**
 * Open a folder as workspace: import/focus app, bind session + chat, navigate to IDE.
 */
export async function openWorkspaceFolder(
  options: OpenWorkspaceFolderOptions,
): Promise<OpenWorkspaceFolderResult | null> {
  const folderPath = options.folderPath.trim();
  if (!folderPath) return null;

  const isRemote = folderPath.startsWith("atlarix-remote://");
  const appName =
    options.appName ??
    (isRemote
      ? folderPath.split("/").filter(Boolean).pop() || "Remote workspace"
      : basenameFromPath(folderPath) || "Workspace");

  try {
    const imported = await IpcClient.getInstance().importApp({
      path: folderPath,
      appName,
      installCommand: options.installCommand,
      startCommand: options.startCommand,
    });

    await options.refreshApps?.();
    await IpcClient.getInstance().touchAppLastOpened(imported.appId);

    const app = await IpcClient.getInstance().getApp(imported.appId);
    const { sessionId, chatId } = await resolveSessionAndChat(imported.appId);

    const store = getDefaultStore();
    attachWorkspaceToChat(chatId, imported.appId, {
      name: app.name,
      path: app.path ?? folderPath,
    });
    store.set(activeWorkspaceSessionIdAtom, sessionId);
    store.set(loadedSessionResumeAtom, false);
    store.set(activeChatIdAtom, chatId);
    store.set(selectedChatIdAtom, chatId);
    store.set(workspaceSessionsRefreshAtom, (n) => n + 1);

    if (!isRemote) {
      pushRecentWorkspace(folderPath);
    }

    options.navigate?.({ to: "/" });

    return {
      appId: imported.appId,
      chatId,
      sessionId,
      path: app.path ?? folderPath,
      name: app.name,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showError(msg);
    return null;
  }
}

export async function openWorkspaceFromDirectoryPicker(options: {
  navigate?: (opts: NavigateOptions) => void;
  refreshApps?: () => Promise<void>;
}): Promise<OpenWorkspaceFolderResult | null> {
  const result = (await window.electron?.ipcRenderer.invoke(
    "dialog:openDirectory",
  )) as { canceled?: boolean; filePaths?: string[] } | undefined;
  if (!result || result.canceled || !result.filePaths?.[0]) return null;
  return openWorkspaceFolder({
    folderPath: result.filePaths[0],
    navigate: options.navigate,
    refreshApps: options.refreshApps,
  });
}
