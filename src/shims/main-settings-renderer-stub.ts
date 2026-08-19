import type { UserSettings } from "@/lib/schemas";

/** Renderer stub — settings are read/written via IPC from the main process. */
export function readSettings(): UserSettings {
  return {
    selectedModel: { name: "core-1", provider: "compass" },
    providerSettings: {},
    telemetryConsent: "unset",
    telemetryUserId: "",
    hasRunBefore: true,
    selectedChatMode: "build",
    enableAutoUpdate: true,
    releaseChannel: "stable",
  } as UserSettings;
}

export async function writeSettings(_settings: UserSettings): Promise<void> {}

/**
 * Crypto stubs — `lib/security/db-secrets.ts` imports these and sits in a
 * main-only chain that the renderer dep scan still walks. Renderer code never
 * calls them; throw loudly if it ever does.
 */
export function encrypt(_value: string): string {
  throw new Error("encrypt() is main-process only (settings stub)");
}

export function decrypt(_value: string): string {
  throw new Error("decrypt() is main-process only (settings stub)");
}
