import { atom } from "jotai";
import type { App, AppOutput, Version } from "@/ipc/ipc_types";
import type { UserSettings } from "@/lib/schemas";

export const currentAppAtom = atom<App | null>(null);
export const selectedAppIdAtom = atom<number | null>(null);
/** Workspace imported mid-chat; applied when user starts a new chat. */
export const pendingWorkspaceAppIdAtom = atom<number | null>(null);
/** First stream per chatId locks workspace context for that thread. */
export const chatBoundAppIdByChatIdAtom = atom<Map<number, number | undefined>>(
  new Map(),
);
// Store workspace info (id + name + path) for reliable display and Code tab when apps list is stale
export const selectedWorkspaceInfoAtom = atom<{ id: number; name: string; path?: string } | null>(null);
export const appsListAtom = atom<App[]>([]);
export const appBasePathAtom = atom<string>("");
export const versionsListAtom = atom<Version[]>([]);
export const previewModeAtom = atom<
  "preview" | "code" | "configure" | "publish" | "security"
>("preview");
export const selectedVersionIdAtom = atom<string | null>(null);
export const appOutputAtom = atom<AppOutput[]>([]);
export const appUrlAtom = atom<
  | { appUrl: string; appId: number; originalUrl: string }
  | { appUrl: null; appId: null; originalUrl: null }
>({ appUrl: null, appId: null, originalUrl: null });
export const userSettingsAtom = atom<UserSettings | null>(null);

// Atom for storing allow-listed environment variables
export const envVarsAtom = atom<Record<string, string | undefined>>({});

export const previewPanelKeyAtom = atom<number>(0);

export const previewErrorMessageAtom = atom<
  { message: string; source: "preview-app" | "atlarix-app" } | undefined
>(undefined);
