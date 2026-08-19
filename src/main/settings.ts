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
  selectedChatMode: "ask",
  workModePreference: "ask",
  buildVerification: {
    enabled: true,
  },
  notificationSound: {
    enabled: true,
    volume: 0.7,
  },
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
    // Deliberately NOT "re-enter your API keys": that advice was wrong often
    // enough to be harmful. The most common cause is the OS keystore being busy
    // for a moment around launch, and the stored ciphertext is preserved on
    // every write now, so it comes back on its own once the keystore does.
    logger.warn(
      "settings: Could not decrypt one or more stored secrets right now (OS keystore busy, changed, or on a different machine). " +
        "The stored values are KEPT and will be readable again once the keystore is available — nothing has been erased. " +
        "Only re-enter a key if it is still missing after a restart.",
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
    return validatedSettings;
  } catch (error) {
    logger.error("Error reading settings:", error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * The settings file exactly as it sits on disk — no decryption, no defaults.
 *
 * `writeSettings` needs this because it must be able to preserve a secret it
 * cannot currently READ. See the comment there.
 */
function readRawSettingsFile(): Record<string, unknown> | null {
  try {
    const filePath = getSettingsFilePath();
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSettings(settings: Partial<UserSettings>): void {
  try {
    const filePath = getSettingsFilePath();
    const currentSettings = readSettings();
    const newSettings = { ...currentSettings, ...settings };

    // A SECRET THE CALLER DID NOT TOUCH IS NEVER REWRITTEN FROM MEMORY.
    //
    // This function used to build entirely on `readSettings()`, which DELETES
    // any secret it fails to decrypt. So a momentarily unavailable OS keystore
    // (the same transient condition the auth layer retries for) turned every
    // later settings write — a theme change, a zoom change, picking a model —
    // into the step that erased the user's API keys from disk permanently. The
    // reported symptom was "I keep losing all my api keys".
    //
    // The rule now: encrypt what the caller explicitly supplied; for anything
    // else, copy the ciphertext already on disk through untouched. Writing no
    // longer depends on being able to read.
    const raw = readRawSettingsFile();
    const rawProviders = (raw?.providerSettings ?? {}) as Record<
      string,
      { apiKey?: unknown; serviceAccountKey?: unknown } | undefined
    >;
    const callerTouchedProviders = settings.providerSettings != null;

    if ("githubAccessToken" in settings) {
      // Explicit: honour it, including an explicit removal.
      if (newSettings.githubAccessToken) {
        newSettings.githubAccessToken = encrypt(
          newSettings.githubAccessToken.value,
        );
      }
    } else if (newSettings.githubAccessToken) {
      newSettings.githubAccessToken = encrypt(
        newSettings.githubAccessToken.value,
      );
    } else if (raw?.githubAccessToken) {
      // Present on disk, unreadable now, untouched by the caller — keep it.
      newSettings.githubAccessToken =
        raw.githubAccessToken as UserSettings["githubAccessToken"];
    }

    for (const provider in newSettings.providerSettings) {
      const callerTouchedThisProvider =
        callerTouchedProviders && settings.providerSettings?.[provider] != null;
      const rawProvider = rawProviders[provider];

      if (newSettings.providerSettings[provider].apiKey) {
        newSettings.providerSettings[provider].apiKey = encrypt(
          newSettings.providerSettings[provider].apiKey.value,
        );
      } else if (!callerTouchedThisProvider && rawProvider?.apiKey) {
        newSettings.providerSettings[provider].apiKey =
          rawProvider.apiKey as NonNullable<
            UserSettings["providerSettings"][string]["apiKey"]
          >;
      }

      // Encrypt Vertex service account key if present
      const v = newSettings.providerSettings[provider] as VertexProviderSetting;
      if (provider === "vertex" && v?.serviceAccountKey) {
        v.serviceAccountKey = encrypt(v.serviceAccountKey.value);
      } else if (
        provider === "vertex" &&
        !callerTouchedThisProvider &&
        rawProvider?.serviceAccountKey
      ) {
        v.serviceAccountKey =
          rawProvider.serviceAccountKey as VertexProviderSetting["serviceAccountKey"];
      }
    }

    // A provider whose ONLY content was an unreadable key is absent from the
    // decrypted view entirely, so the loop above never visits it. Carry those
    // through too, or the key vanishes exactly as before.
    if (raw?.providerSettings) {
      for (const provider in rawProviders) {
        if (newSettings.providerSettings[provider]) continue;
        if (callerTouchedProviders && settings.providerSettings?.[provider] != null) continue;
        const rawProvider = rawProviders[provider];
        if (rawProvider?.apiKey || rawProvider?.serviceAccountKey) {
          newSettings.providerSettings[provider] =
            rawProvider as UserSettings["providerSettings"][string];
        }
      }
    }
    const validatedSettings = UserSettingsSchema.parse(newSettings);
    fs.writeFileSync(filePath, JSON.stringify(validatedSettings, null, 2));
    // The settings file holds provider keys + OAuth tokens (encrypted when a
    // keystore is available, plaintext otherwise). Restrict it to the owner on
    // POSIX so other local users can't read the fallback plaintext. (no-op on
    // Windows, where ACLs govern instead — guarded to avoid an EPERM throw.)
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        /* best-effort hardening */
      }
    }
  } catch (error) {
    logger.error("Error writing settings:", error);
  }
}

/** True when OS-backed secret encryption is active (else keys persist plaintext). */
export function isSecretEncryptionAvailable(): boolean {
  if (IS_TEST_BUILD) return true;
  return getSafeStorage()?.isEncryptionAvailable() === true;
}

/**
 * A20/L-5 recovery: if the OS keystore is now available but stored secrets are
 * still `plaintext` (written while it was down — e.g. before gnome-keyring was
 * installed), re-encrypt them. `readSettings` decrypts to plaintext values, so a
 * no-op `writeSettings({})` re-encrypts every secret via the now-available
 * keystore. Cheap-guarded: only writes when a plaintext secret actually exists.
 */
export function reEncryptPlaintextSecretsIfPossible(): void {
  if (!isSecretEncryptionAvailable()) return;
  try {
    const s = readSettings();
    const isPlain = (sec?: { encryptionType?: string }) =>
      sec?.encryptionType === "plaintext";
    let hasPlaintext = isPlain(s.githubAccessToken);
    for (const p in s.providerSettings ?? {}) {
      const ps = s.providerSettings[p] as { apiKey?: Secret } & VertexProviderSetting;
      if (isPlain(ps.apiKey)) hasPlaintext = true;
      if (p === "vertex" && isPlain(ps.serviceAccountKey)) hasPlaintext = true;
    }
    if (!hasPlaintext) return;
    writeSettings({});
    logger.log(
      "[settings] OS keystore recovered — re-encrypted previously-plaintext secrets.",
    );
  } catch (error) {
    logger.warn("[settings] re-encrypt on recovery failed:", error);
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
