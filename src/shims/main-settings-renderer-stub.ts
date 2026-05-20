import type { UserSettings } from "@/lib/schemas";

/** Renderer stub — settings are read/written via IPC from the main process. */
export function readSettings(): UserSettings {
  return {
    selectedModel: { name: "compass-fast", provider: "compass" },
    providerSettings: {},
    telemetryConsent: "unset",
    telemetryUserId: "",
    hasRunBefore: true,
    experiments: {},
    enableProLazyEditsMode: true,
    enableProSmartFilesContextMode: true,
    enableProWebSearch: false,
    selectedChatMode: "build",
    enableAutoFixProblems: false,
    enableAutoUpdate: true,
    releaseChannel: "stable",
    selectedTemplateId: "react-vite",
  } as UserSettings;
}

export async function writeSettings(_settings: UserSettings): Promise<void> {}
