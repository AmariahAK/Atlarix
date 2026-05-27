import { atom } from "jotai";

export type WorkspaceSidebarTab = "files" | "sessions";

export const workspaceSidebarTabAtom = atom<WorkspaceSidebarTab>("files");

export const activeWorkspaceSessionIdAtom = atom<string | null>(null);

/** True when UI shows history from a loaded session but model context is empty. */
export const loadedSessionResumeAtom = atom<boolean>(false);

export const chatIdToSessionIdAtom = atom<Map<number, string>>(new Map());

/** Inverse map for reusing chat transport when switching sessions. */
export const sessionIdToChatIdAtom = atom<Map<string, number>>(new Map());

export const workspaceSessionLoadingAtom = atom<boolean>(false);

export const workspaceSessionLoadingLabelAtom = atom<string>("Loading session…");

export const loadedSessionTruncatedAtom = atom<boolean>(false);

/** Bump to reload workspace session lists after create/rename. */
export const workspaceSessionsRefreshAtom = atom(0);

/** Session ids currently awaiting AI-generated titles. */
export const workspaceSessionTitleGeneratingAtom = atom<Set<string>>(new Set());
