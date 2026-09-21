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
// Store workspace info (id + name + path) for reliable display when apps list is stale
export const selectedWorkspaceInfoAtom = atom<{
  id: number;
  name: string;
  path?: string;
} | null>(null);
export const appsListAtom = atom<App[]>([]);

/**
 * Open state of the workspace-search palette (Cmd/Ctrl+K).
 *
 * Lifted out of `AppList` so the dialog can be mounted at the app root. Its
 * keydown listener lives inside the dialog, and the dialog used to be mounted
 * ONLY from `AppList` — which renders nothing unless the Apps rail item is
 * showing. So the chord did nothing most of the time, and `shortcuts.ts` had
 * to carry it as `status: "hidden"` to avoid advertising a key the app did not
 * reliably listen for.
 */
export const appSearchOpenAtom = atom<boolean>(false);
export const appBasePathAtom = atom<string>("");
export const versionsListAtom = atom<Version[]>([]);
export const appOutputAtom = atom<AppOutput[]>([]);
export const appUrlAtom = atom<
  | { appUrl: string; appId: number; originalUrl: string }
  | { appUrl: null; appId: null; originalUrl: null }
>({ appUrl: null, appId: null, originalUrl: null });
export const userSettingsAtom = atom<UserSettings | null>(null);

// Atom for storing allow-listed environment variables
export const envVarsAtom = atom<Record<string, string | undefined>>({});

export const previewErrorMessageAtom = atom<
  { message: string; source: "preview-app" | "atlarix-app" } | undefined
>(undefined);
