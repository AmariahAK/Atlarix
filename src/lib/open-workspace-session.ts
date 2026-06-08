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
  openChatTabsAtom,
} from "@/atoms/chatAtoms";
import {
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import { loadedSessionTruncatedAtom } from "@/atoms/sessionAtoms";
import { pushRecentWorkspace } from "@/lib/workspace-recents";
import { showError } from "@/lib/toast";
import { resetTerminalInstancesForNewChat } from "@/lib/reset-terminal-instances";

/**
 * Add or update an open-session tab (dedupe by chatId), preserving the order
 * and the other open sessions. Called whenever a workspace conversation becomes
 * active so concurrent/background sessions stay reachable via the tab strip.
 */
export function registerOpenChatTab(tab: {
  chatId: number;
  appId: number | null;
  title: string;
}): void {
  const store = getDefaultStore();
  store.set(openChatTabsAtom, (prev) => {
    const existing = prev.find((t) => t.chatId === tab.chatId);
    if (existing) {
      return prev.map((t) =>
        t.chatId === tab.chatId
          ? { ...t, appId: tab.appId, title: tab.title || t.title }
          : t,
      );
    }
    return [...prev, tab];
  });
}

/** Remove a tab (and let the caller decide the next active chat). */
export function removeOpenChatTab(chatId: number): void {
  const store = getDefaultStore();
  store.set(openChatTabsAtom, (prev) => prev.filter((t) => t.chatId !== chatId));
}

export type OpenWorkspaceFolderResult = {
  appId: number;
  chatId: number;
  sessionId: string;
  path: string;
  name: string;
};

/**
 * Workspaces require a signed-in user. Checks the main-process session and, if
 * absent, surfaces a sign-in prompt and returns false. The backend session
 * handlers enforce this too (requireAuthSession) — this is the friendly UX gate.
 */
async function ensureSignedInForWorkspace(): Promise<boolean> {
  try {
    const res = (await window.electron?.ipcRenderer.invoke(
      "auth:get-current-user",
    )) as { user?: unknown } | undefined;
    if (res?.user) return true;
  } catch {
    /* treat as signed-out */
  }
  showError("Please sign in to open a workspace.");
  return false;
}

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
    if (!(await ensureSignedInForWorkspace())) return null;
    const ipc = IpcClient.getInstance();
    const app = await ipc.getApp(workspaceId);
    if (app.pathExists === false) {
      showError("Workspace folder not found. Remove it from the list and try again.");
      return null;
    }

    const name = options.workspaceName ?? app.name ?? "Workspace";
    const workspacePath = options.workspacePath ?? app.path ?? "";

    const { sessionId, chatId } =
      await ipc.startWorkspaceConversation(workspaceId);
    resetTerminalInstancesForNewChat();
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
    store.set(activeWorkspaceSessionIdAtom, sessionId);
    store.set(loadedSessionResumeAtom, false);
    store.set(loadedSessionTruncatedAtom, false);
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
    store.set(chatMessagesByIdAtom, (prev) => {
      const next = new Map(prev);
      next.set(chatId, []);
      return next;
    });
    store.set(activeChatIdAtom, chatId);
    store.set(selectedChatIdAtom, chatId);
    registerOpenChatTab({ chatId, appId: workspaceId, title: name });
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
    const { chatId } = await ipc.allocateSessionTransport(sessionId);
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

  const { sessionId, chatId } =
    await ipc.startWorkspaceConversation(workspaceAppId);
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

export type OpenWorkspaceByAppIdOptions = {
  appId: number;
  /** Absolute path for recents (falls back to app.path from DB) */
  folderPath?: string;
  navigate?: (opts: NavigateOptions) => void;
  refreshApps?: () => Promise<void>;
};

/**
 * Open a workspace already registered in the DB (e.g. after GitHub clone).
 * Does not run import-app again.
 */
export async function openWorkspaceByAppId(
  options: OpenWorkspaceByAppIdOptions,
): Promise<OpenWorkspaceFolderResult | null> {
  const { appId } = options;
  try {
    if (!(await ensureSignedInForWorkspace())) return null;
    await options.refreshApps?.();
    await IpcClient.getInstance().touchAppLastOpened(appId);

    const app = await IpcClient.getInstance().getApp(appId);
    if (app.pathExists === false) {
      showError("Workspace folder not found. Remove it from the list and try again.");
      return null;
    }

    const folderPath = options.folderPath?.trim() || app.path?.trim() || "";
    const { sessionId, chatId } = await resolveSessionAndChat(appId);

    const store = getDefaultStore();
    attachWorkspaceToChat(chatId, appId, {
      name: app.name,
      path: folderPath || app.path || undefined,
    });
    store.set(selectedAppIdAtom, appId);
    store.set(selectedWorkspaceInfoAtom, {
      id: appId,
      name: app.name,
      path: folderPath || app.path || "",
    });
    store.set(activeWorkspaceSessionIdAtom, sessionId);
    store.set(loadedSessionResumeAtom, false);
    store.set(activeChatIdAtom, chatId);
    store.set(selectedChatIdAtom, chatId);
    registerOpenChatTab({ chatId, appId, title: app.name });
    store.set(workspaceSessionsRefreshAtom, (n) => n + 1);

    if (folderPath && !folderPath.startsWith("atlarix-remote://")) {
      pushRecentWorkspace(folderPath);
    }

    options.navigate?.({ to: "/" });

    return {
      appId,
      chatId,
      sessionId,
      path: folderPath || app.path || "",
      name: app.name,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showError(msg);
    return null;
  }
}

/**
 * Open a folder as workspace: import/focus app, bind session + chat, navigate to IDE.
 */
export async function openWorkspaceFolder(
  options: OpenWorkspaceFolderOptions,
): Promise<OpenWorkspaceFolderResult | null> {
  const folderPath = options.folderPath.trim();
  if (!folderPath) return null;

  if (!(await ensureSignedInForWorkspace())) return null;

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
      installCommand: options.installCommand ?? undefined,
      startCommand: options.startCommand ?? undefined,
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
    registerOpenChatTab({ chatId, appId: imported.appId, title: app.name });
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
