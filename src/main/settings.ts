import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getUserDataPath } from "../paths/paths";
import {
  UserSettingsSchema,
  type UserSettings,
  Secret,
  VertexProviderSetting,
} from "../lib/schemas";
import { v4 as uuidv4 } from "uuid";
import log from "electron-log";
import { IS_TEST_BUILD } from "@/ipc/utils/test_utils";

const logger = log.scope("settings");

type SafeStorageApi = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

let safeStorageCache: SafeStorageApi | null | undefined;
let safeStorageTestOverride: SafeStorageApi | null | undefined;

const requireElectron = createRequire(
  typeof import.meta.url === "string"
    ? import.meta.url
    : path.join(__dirname, "settings.js"),
);

/** @internal Vitest — wire the same mocked `electron.safeStorage` as `import { safeStorage } from "electron"`. */
export function __injectSafeStorageForTests(api: SafeStorageApi | null | undefined): void {
  safeStorageTestOverride = api;
  safeStorageCache = undefined;
}

/** Lazy-load Electron safeStorage so headless CI (tsx benchmarks) can import readSettings. */
function getSafeStorage(): SafeStorageApi | null {
  if (safeStorageTestOverride !== undefined) return safeStorageTestOverride;
  if (safeStorageCache !== undefined) return safeStorageCache;
  try {
    const electron = requireElectron("electron") as typeof import("electron");
    safeStorageCache = electron.safeStorage ?? null;
  } catch {
    safeStorageCache = null;
  }
  return safeStorageCache;
}

// IF YOU NEED TO UPDATE THIS, YOU'RE PROBABLY DOING SOMETHING WRONG!
// Need to maintain backwards compatibility!
const DEFAULT_SETTINGS: UserSettings = {
  selectedModel: {
    name: "core-1",
    provider: "compass",
  },
  providerSettings: {},
  telemetryConsent: "unset",
  telemetryUserId: uuidv4(),
  hasRunBefore: false,
  enableProLazyEditsMode: true,
  enableProSmartFilesContextMode: true,
  selectedChatMode: "ask",
  workModePreference: "ask",
  buildVerification: {
    enabled: true,
  },
  notificationSound: {
    enabled: true,
    volume: 0.7,
  },
  /** When true, after a build-mode turn completes, may auto-queue up to 2 synthetic fix turns (TS / dev output / tests). Ask-only chats are unaffected. */
  enableContextAutoSummarize: true, // Phase 6: context bar + auto-summarize
  includeAtlarixCoAuthor: true,
  enableAutoUpdate: true,
  releaseChannel: "stable",
  isRunning: false,
  lastKnownPerformance: undefined,
};

const SETTINGS_FILE = "user-settings.json";

export function getSettingsFilePath(): string {
  return path.join(getUserDataPath(), SETTINGS_FILE);
}

/** Decrypt a stored secret; on failure (corrupt blob, keychain rotation), drop it and log once per read. */
function tryDecryptSecret(
  secret: Secret,
  onFirstFailure: (err: unknown) => void,
): string | undefined {
  try {
    return decrypt(secret);
  } catch (err) {
    onFirstFailure(err);
    return undefined;
  }
}

export function readSettings(): UserSettings {
  let decryptFailureLogged = false;
  const onDecryptFailure = (err: unknown) => {
    if (decryptFailureLogged) return;
    decryptFailureLogged = true;
    logger.warn(
      "settings: Could not decrypt one or more stored secrets (OS keychain changed, different machine, or corrupt data). Re-enter API keys or sign in again in Settings.",
      err,
    );
  };

  try {
    const filePath = getSettingsFilePath();
    if (!fs.existsSync(filePath)) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(DEFAULT_SETTINGS, null, 2));
      } catch (writeErr) {
        // Headless / test environments may not have a writable userData dir.
        // Returning defaults keeps callers (e.g. getCurrentCommitHash) working.
        logger.debug("settings: could not seed defaults", writeErr);
      }
      return DEFAULT_SETTINGS;
    }
    const rawSettings = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const combinedSettings: UserSettings = {
      ...DEFAULT_SETTINGS,
      ...rawSettings,
    };
    // Migrate legacy settings key (written once on next save via normal paths)
    const legacy = combinedSettings as UserSettings & {
      dyadProBudget?: unknown;
    };
    if (legacy.dyadProBudget != null && legacy.atlarixProBudget == null) {
      legacy.atlarixProBudget = legacy.dyadProBudget as UserSettings["atlarixProBudget"];
    }
    delete legacy.dyadProBudget;
    // v11: persisted pre-Core selections (`compass-*`) normalize to `core-N`
    // so the picker shows the new names (resolution also aliases at runtime).
    if (combinedSettings.selectedModel?.provider === "compass") {
      const legacyCoreAliases: Record<string, string> = {
        "compass-fast": "core-1",
        "compass-balanced": "core-2",
        "compass-thinking": "core-3",
      };
      const mapped = legacyCoreAliases[combinedSettings.selectedModel.name];
      if (mapped) {
        combinedSettings.selectedModel = {
          ...combinedSettings.selectedModel,
          name: mapped,
        };
      }
    }
    // v12 0.1: the vestigial "agent" chat-mode path was deleted — persisted
    // legacy rows coerce to "build" (the same loop, correctly wired). The
    // schema still parses "agent" so old settings files load; written back as
    // "build" on the next normal save.
    if (combinedSettings.selectedChatMode === "agent") {
      combinedSettings.selectedChatMode = "build";
    }
    // v13.6: the fast/balanced/thinking model tiers were removed. Persisted
    // `summarizationModel`/`reviewModel`/`agentModel` values of "fast"/"balanced"
    // are no longer valid enum members — coerce to "same" BEFORE the zod parse
    // below or it would reject and reset the whole settings file. Users keep
    // their explicit "custom" picks. (Mirrors the compass-* mapping above.)
    const ai = combinedSettings.aiConfiguration as
      | {
          contextSummarization?: { summarizationModel?: string };
          selfReview?: { reviewModel?: string };
          guided?: { agentModel?: string };
        }
      | undefined;
    const coerceTierModel = (v: string | undefined): string | undefined =>
      v === "fast" || v === "balanced" ? "same" : v;
    if (ai?.contextSummarization?.summarizationModel) {
      ai.contextSummarization.summarizationModel = coerceTierModel(
        ai.contextSummarization.summarizationModel,
      );
    }
    if (ai?.selfReview?.reviewModel) {
      ai.selfReview.reviewModel = coerceTierModel(ai.selfReview.reviewModel);
    }
    if (ai?.guided?.agentModel) {
      ai.guided.agentModel = coerceTierModel(ai.guided.agentModel);
    }
    if (combinedSettings.githubAccessToken) {
      const encryptionType = combinedSettings.githubAccessToken.encryptionType;
      const value = tryDecryptSecret(
        combinedSettings.githubAccessToken,
        onDecryptFailure,
      );
      if (value !== undefined) {
        combinedSettings.githubAccessToken = {
          value,
          encryptionType,
        };
      } else {
        delete combinedSettings.githubAccessToken;
      }
    }
    for (const provider in combinedSettings.providerSettings) {
      if (combinedSettings.providerSettings[provider].apiKey) {
        const encryptionType =
          combinedSettings.providerSettings[provider].apiKey.encryptionType;
        const value = tryDecryptSecret(
          combinedSettings.providerSettings[provider].apiKey!,
          onDecryptFailure,
        );
        if (value !== undefined) {
          combinedSettings.providerSettings[provider].apiKey = {
            value,
            encryptionType,
          };
        } else {
          delete combinedSettings.providerSettings[provider].apiKey;
        }
      }
      // Decrypt Vertex service account key if present
      const v = combinedSettings.providerSettings[
        provider
      ] as VertexProviderSetting;
      if (provider === "vertex" && v?.serviceAccountKey) {
        const encryptionType = v.serviceAccountKey.encryptionType;
        const value = tryDecryptSecret(v.serviceAccountKey, onDecryptFailure);
        if (value !== undefined) {
          v.serviceAccountKey = {
            value,
            encryptionType,
          };
        } else {
          delete v.serviceAccountKey;
        }
      }
    }

    // Validate and merge with defaults
    const validatedSettings = UserSettingsSchema.parse(combinedSettings);
    // "conservative" is deprecated, use undefined to use the default value
    if (validatedSettings.proSmartContextOption === "conservative") {
      validatedSettings.proSmartContextOption = undefined;
    }
    return validatedSettings;
  } catch (error) {
    logger.error("Error reading settings:", error);
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(settings: Partial<UserSettings>): void {
  try {
    const filePath = getSettingsFilePath();
    const currentSettings = readSettings();
    const newSettings = { ...currentSettings, ...settings };
    if (newSettings.githubAccessToken) {
      newSettings.githubAccessToken = encrypt(
        newSettings.githubAccessToken.value,
      );
    }
    for (const provider in newSettings.providerSettings) {
      if (newSettings.providerSettings[provider].apiKey) {
        newSettings.providerSettings[provider].apiKey = encrypt(
          newSettings.providerSettings[provider].apiKey.value,
        );
      }
      // Encrypt Vertex service account key if present
      const v = newSettings.providerSettings[provider] as VertexProviderSetting;
      if (provider === "vertex" && v?.serviceAccountKey) {
        v.serviceAccountKey = encrypt(v.serviceAccountKey.value);
      }
    }
    const validatedSettings = UserSettingsSchema.parse(newSettings);
    fs.writeFileSync(filePath, JSON.stringify(validatedSettings, null, 2));
  } catch (error) {
    logger.error("Error writing settings:", error);
  }
}

let warnedPlaintextSecret = false;

export function encrypt(data: string): Secret {
  const safeStorage = getSafeStorage();
  if (safeStorage?.isEncryptionAvailable() && !IS_TEST_BUILD) {
    return {
      value: safeStorage.encryptString(data).toString("base64"),
      encryptionType: "electron-safe-storage",
    };
  }
  // A20/L-5: OS encryption unavailable (e.g. Linux without a Secret Service /
  // keyring) — the secret is persisted in cleartext. Warn once so this degraded
  // mode is visible in logs rather than silent. (Test builds intentionally use
  // plaintext and are not warned.)
  if (!IS_TEST_BUILD && !warnedPlaintextSecret) {
    warnedPlaintextSecret = true;
    logger.warn(
      "safeStorage/OS encryption is unavailable — provider keys and OAuth tokens are being stored WITHOUT encryption (plaintext at rest). Install a system keyring (e.g. gnome-keyring / libsecret) to enable encryption.",
    );
  }
  return {
    value: data,
    encryptionType: "plaintext",
  };
}

export function decrypt(data: Secret): string {
  if (data.encryptionType === "electron-safe-storage") {
    const safeStorage = getSafeStorage();
    if (!safeStorage) {
      throw new Error("Electron safeStorage is unavailable");
    }
    return safeStorage.decryptString(Buffer.from(data.value, "base64"));
  }
  return data.value;
}
