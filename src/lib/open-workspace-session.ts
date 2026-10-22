/**
 * Unified workspace open → session → ephemeral chat → IDE navigation.
 */

import { getDefaultStore } from "jotai";
import { basenameFromPath } from "@/lib/path-basename";
import type { NavigateOptions } from "@tanstack/react-router";
import { IpcClient } from "@/ipc/ipc_client";
import { attachWorkspaceToChat } from "@/lib/chat-workspace-binding";
import {
  activeSessionWorkModeAtom,
  activeWorkspaceSessionIdAtom,
  chatIdToSessionIdAtom,
  sessionIdToChatIdAtom,
  loadedSessionResumeAtom,
  workspaceSessionsRefreshAtom,
} from "@/atoms/sessionAtoms";
import type { WorkMode } from "@/lib/schemas";
import {
  activeChatIdAtom,
  chatMessagesByIdAtom,
  selectedChatIdAtom,
  openChatTabsAtom,
} from "@/atoms/chatAtoms";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { loadedSessionTruncatedAtom } from "@/atoms/sessionAtoms";
import { pushRecentWorkspace } from "@/lib/workspace-recents";
import { showError } from "@/lib/toast";
import { resetTerminalInstancesForNewChat } from "@/lib/reset-terminal-instances";
import { clearChatAtomsForChat } from "@/lib/chat/clear-chat-atoms";

/**
 * Add or update an open-session tab (dedupe by chatId), preserving the order
 * and the other open sessions. Called whenever a workspace conversation becomes
 * active so concurrent/background sessions stay reachable via the tab strip.
 */
/**
 * Activate a session and hydrate the work mode it stores.
 *
 * One function because the two must not drift: an activation that sets the id
 * without the mode leaves the previous session's mode showing on the chip AND
 * driving the next turn — which is the bug this whole change exists to end, just
 * relocated from global settings to a stale atom.
 *
 * `workMode` is `undefined` when the caller has no row to read from (the
 * streaming fast path). That is NOT the same as `null`: `null` means the session
 * genuinely has no stored mode and should resolve from the global preference,
 * while `undefined` means "unknown, leave what is there" — a streaming session
 * was activated moments ago and its atom is already correct.
 */
export function activateWorkspaceSession(
  sessionId: string,
  workMode?: WorkMode | null,
): void {
  const store = getDefaultStore();
  store.set(activeWorkspaceSessionIdAtom, sessionId);
  if (workMode !== undefined) {
    store.set(activeSessionWorkModeAtom, workMode);
  }
}

/**
 * Activate a session whose row isn't at hand (the tab strip): the id now, its
 * stored mode as soon as it's read — unless another session became active
 * meanwhile. Switching by tab used to set the id only, so the previous
 * session's mode stayed on the chip and ran the next turn (QA #13).
 */
export async function activateWorkspaceSessionById(
  sessionId: string,
): Promise<void> {
  activateWorkspaceSession(sessionId, undefined);
  const res = (await IpcClient.getInstance()
    .getWorkspaceSession(sessionId, { limit: 1 })
    .catch(() => null)) as { session?: { workMode?: WorkMode | null } } | null;
  if (!res?.session) return;
  if (getDefaultStore().get(activeWorkspaceSessionIdAtom) !== sessionId) return;
  activateWorkspaceSession(sessionId, res.session.workMode ?? null);
}

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
  store.set(openChatTabsAtom, (prev) =>
    prev.filter((t) => t.chatId !== chatId),
  );
}

/**
 * v14.8.11: sync a session RENAME into the tab strip. Tab titles are
 * snapshots taken at open time (registerOpenChatTab), so the auto-title and
 * manual-rename paths — which only refresh the sidebar — left the tab frozen
 * at "Untitled". Resolves the session's open chat(s) via chatIdToSessionIdAtom
 * and OVERWRITES the stale title (unlike registerOpenChatTab's update branch,
 * which deliberately keeps an existing title).
 */
export function updateOpenChatTabTitleForSession(
  sessionId: string,
  title: string,
): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  const store = getDefaultStore();
  const chatMap = store.get(chatIdToSessionIdAtom);
  const chatIds = new Set(
    [...chatMap.entries()]
      .filter(([, sid]) => sid === sessionId)
      .map(([chatId]) => chatId),
  );
  if (chatIds.size === 0) return;
  // Unchanged stays the same array: the sessions list calls this for every
  // session each time it re-reads (item 6), and tabs must not redraw for that.
  store.set(openChatTabsAtom, (prev) =>
    prev.some((t) => chatIds.has(t.chatId) && t.title !== trimmed)
      ? prev.map((t) => (chatIds.has(t.chatId) ? { ...t, title: trimmed } : t))
      : prev,
  );
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
      showError(
        "Workspace folder not found. Remove it from the list and try again.",
      );
      return null;
    }

    const name = options.workspaceName ?? app.name ?? "Workspace";
    const workspacePath = options.workspacePath ?? app.path ?? "";

    const { sessionId, chatId } =
      await ipc.startWorkspaceConversation(workspaceId);
    resetTerminalInstancesForNewChat();
    // Defensive: a brand-new conversation must never inherit stale per-chat
    // state (e.g. a pending ask_user question) if this chatId was ever reused.
    clearChatAtomsForChat(chatId);
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
    // A brand-new session has no stored mode: `null` so it resolves from the
    // global preference, and so the mode of whatever session you were just in
    // does not follow you into a fresh chat.
    activateWorkspaceSession(sessionId, null);
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

/**
 * REOPENING A WORKSPACE LANDS ON A FRESH UNTITLED, not on the newest session.
 *
 * It used to resume `sessions[0]` sorted by `updatedAt` desc. That is also the
 * order `sessions:list` returns (`workspace_session_handlers.ts`, `orderBy(desc(
 * updatedAt))`), so the resumed session was ALWAYS the top row — and
 * `WorkspaceSessionList` early-returns when the clicked row is already active.
 * Net effect: the top session could not be opened at all until you clicked a
 * different one and came back. Reported 2026-09-06.
 *
 * `startWorkspaceConversation` is the right call rather than a bare create: its
 * handler reuses a most-recent session that is still default-titled with zero
 * messages and prunes other stale empties, so repeated reopens do not accumulate
 * Untitled rows. The CLI path (`import_workspace_core.ts`) has always gone through
 * it; this makes the renderer agree instead of diverging.
 *
 * `workMode: null` is deliberate — a session created a moment ago has no stored
 * mode, so it resolves from the global preference, and the previous session's mode
 * must not carry into a brand-new one.
 */
async function resolveSessionAndChat(
  workspaceAppId: number,
): Promise<{ sessionId: string; chatId: number; workMode: WorkMode | null }> {
  const ipc = IpcClient.getInstance();
  const store = getDefaultStore();

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
  return { sessionId, chatId, workMode: null };
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
      showError(
        "Workspace folder not found. Remove it from the list and try again.",
      );
      return null;
    }

    const folderPath = options.folderPath?.trim() || app.path?.trim() || "";
    const { sessionId, chatId, workMode } = await resolveSessionAndChat(appId);

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
    activateWorkspaceSession(sessionId, workMode);
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
    const { sessionId, chatId, workMode } = await resolveSessionAndChat(
      imported.appId,
    );

    const store = getDefaultStore();
    attachWorkspaceToChat(chatId, imported.appId, {
      name: app.name,
      path: app.path ?? folderPath,
    });
    activateWorkspaceSession(sessionId, workMode);
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
