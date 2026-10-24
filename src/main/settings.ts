import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getUserDataPath } from "../paths/paths";
import {
  DEFAULT_NEW_USER_CORE_TIER,
  DEFAULT_PAID_CORE_TIER,
} from "../ipc/shared/compass_constants";
import {
  UserSettingsSchema,
  type UserSettings,
  Secret,
  VertexProviderSetting,
} from "../lib/schemas";
import { v4 as uuidv4 } from "uuid";
import log from "electron-log";

const logger = log.scope("settings");

type SafeStorageApi = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

let safeStorageCache: SafeStorageApi | null | undefined;
let safeStorageTestOverride: SafeStorageApi | null | undefined;
let appReadyTestOverride: boolean | null = null;

const requireElectron = createRequire(
  typeof import.meta.url === "string"
    ? import.meta.url
    : path.join(__dirname, "settings.js"),
);

/** @internal Vitest — wire the same mocked `electron.safeStorage` as `import { safeStorage } from "electron"`. */
export function __injectSafeStorageForTests(
  api: SafeStorageApi | null | undefined,
): void {
  safeStorageTestOverride = api;
  safeStorageCache = undefined;
}

/**
 * A read that happened before the app was ready — which is NOT a keystore failure.
 *
 * `resolveSystemPath()` runs at module scope in `src/main.ts`, before
 * `app.whenReady()`, and it reads `customNodePath` — a PLAINTEXT field. Getting it
 * costs a full `readSettings()`, which decrypts every stored secret on the way past,
 * and Electron refuses `safeStorage` before ready. So every single launch logged a
 * warning telling the user their OS keystore might be busy, when nothing was wrong
 * and nothing was lost: `readSettings` does not cache, so the next read (after ready)
 * decrypts fine.
 *
 * Distinguished rather than silenced, because the two are genuinely different events
 * and only one of them is worth telling a user about. The warning that fires for a
 * real keystore failure is carefully worded and stays exactly as it is.
 */
export class SafeStorageNotReadyError extends Error {
  constructor() {
    super("safeStorage was read before the app was ready");
    this.name = "SafeStorageNotReadyError";
  }
}

/**
 * `true` / `false` when Electron can be asked, `null` when it cannot — headless CI and
 * the tsx benchmarks import this module with no Electron at all. A `null` is treated as
 * ready by every caller: refusing to decrypt because we could not find `app` would
 * break the environments this lazy-load exists to support.
 */
function isElectronAppReady(): boolean | null {
  if (safeStorageTestOverride !== undefined) return appReadyTestOverride;
  try {
    const electron = requireElectron("electron") as typeof import("electron");
    return electron.app?.isReady() ?? null;
  } catch {
    return null;
  }
}

/** @internal Vitest — simulate a pre-ready main process alongside an injected safeStorage. */
export function __injectAppReadyForTests(ready: boolean | null): void {
  appReadyTestOverride = ready;
}

/**
 * The CLI's stand-in for Electron safeStorage (src/runtime/oscrypt.ts), so it
 * reads and writes the same encrypted secrets as the desktop app. It cannot
 * come through `requireElectron`: that is a runtime require, which the compiled
 * CLI cannot redirect to its electron stub.
 */
export function useSafeStorageProvider(api: SafeStorageApi): void {
  safeStorageCache = api;
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
  /**
   * The tier a brand-new install lands on — A SLOT, never a model id, so which
   * model sits behind it stays `core-models.json`'s business and changes without
   * an app update.
   *
   * WHY THIS IS THE CONSTANT AND NOT A LITERAL. "The default Core tier" was
   * written down in two unrelated places that had no link between them: here, and
   * `DEFAULT_CORE_TIER_ORDER` in compass_constants. Moving the latter to core-3
   * therefore moved nothing a real user sees — its only production caller is the
   * BYOK-rescue path — while this line quietly kept every new install on core-1.
   * One of the two had to become the other's source of truth.
   */
  selectedModel: {
    name: DEFAULT_NEW_USER_CORE_TIER,
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

/**
 * Settings THIS PROCESS sees differently, never written to disk. The CLI shares
 * the desktop's settings file; its own choices (deep thinking on or off) must
 * not flip the desktop app's. Merged on read only; writeSettings works from the
 * file itself, so an override can never leak into it.
 */
let runtimeOverride: Partial<UserSettings> = {};

export function setRuntimeSettingsOverride(patch: Partial<UserSettings>): void {
  runtimeOverride = { ...runtimeOverride, ...patch };
}

export function readSettings(): UserSettings {
  const fromFile = readSettingsFromFile();
  return Object.keys(runtimeOverride).length ? { ...fromFile, ...runtimeOverride } : fromFile;
}

function readSettingsFromFile(): UserSettings {
  let decryptFailureLogged = false;
  const onDecryptFailure = (err: unknown) => {
    if (decryptFailureLogged) return;
    decryptFailureLogged = true;
    // A pre-ready read is not a keystore problem and must not be reported as one.
    // Nothing was lost — `readSettings` does not cache, so the caller that ran
    // before `app.whenReady()` got the plaintext fields it wanted and the next
    // read decrypts normally. Kept at debug rather than dropped, because "the
    // secrets came back empty" is still worth being able to see in a log when
    // chasing something else.
    if (err instanceof SafeStorageNotReadyError) {
      logger.debug(
        "settings: read before the app was ready, so stored secrets were not decrypted. " +
          "Nothing is wrong and nothing was written — the next read gets them.",
      );
      return;
    }
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
    // The old "auto" PROVIDER (automatic model routing) was removed, and a
    // selection still carrying it failed every turn with "Automatic model
    // routing was removed". It moves to the default PAID Core tier: a saved
    // choice keeps meaning "a model I pay for", and Atlarix Auto stays the
    // default only for installs that never chose.
    if (combinedSettings.selectedModel?.provider === "auto") {
      combinedSettings.selectedModel = {
        provider: "compass",
        name: DEFAULT_PAID_CORE_TIER,
      };
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

/**
 * Whether the settings file holds a key for this provider, readable or not.
 * readSettings drops a key it can't decrypt (keychain busy or changed), so
 * "no key" there can mean "a key we can't read now", which must not be taken
 * for "no key at all".
 */
export function hasStoredProviderKey(providerId: string): boolean {
  const providers = readRawSettingsFile()?.providerSettings as
    | Record<string, { apiKey?: { value?: unknown } } | undefined>
    | undefined;
  const v = providers?.[providerId]?.apiKey?.value;
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Save (or, with null, remove) ONE provider's key, leaving everything else in
 * the file exactly as it is on disk: other providers' keys and settings, and
 * this provider's own non-key settings.
 *
 * `writeSettings` replaces `providerSettings` wholesale, so the CLI's
 * `{ providerSettings: { [id]: { apiKey } } }` kept only the providers that had
 * a key and dropped every other provider's settings.
 */
/**
 * Forget saved settings (key, on/off) for custom providers that no longer
 * exist: deleting one left its key behind in this file (owner: providers he
 * never added, from test runs, with their keys still stored). `keep` is every
 * custom provider id still in the database; built-in providers are untouched.
 */
export function pruneCustomProviderSettings(keep: ReadonlySet<string>): string[] {
  const raw = readRawSettingsFile();
  if (!raw) return [];
  const providers = { ...((raw.providerSettings ?? {}) as Record<string, unknown>) };
  const gone = Object.keys(providers).filter((id) => id.startsWith("custom::") && !keep.has(id));
  if (!gone.length) return [];
  for (const id of gone) delete providers[id];
  const validated = UserSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...raw, providerSettings: providers });
  const filePath = getSettingsFilePath();
  fs.writeFileSync(filePath, JSON.stringify(validated, null, 2));
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort hardening, as writeSettings */
    }
  }
  return gone;
}

export function writeProviderKey(providerId: string, key: string | null): void {
  const raw = readRawSettingsFile();
  const value = key?.trim();
  if (!raw) {
    if (value) writeSettings({ providerSettings: { [providerId]: { apiKey: { value } } } } as Partial<UserSettings>);
    return;
  }
  const providers = { ...((raw.providerSettings ?? {}) as Record<string, Record<string, unknown>>) };
  const entry = { ...(providers[providerId] ?? {}) };
  if (value) entry.apiKey = encrypt(value);
  else delete entry.apiKey;
  providers[providerId] = entry;
  const validated = UserSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...raw, providerSettings: providers });
  const filePath = getSettingsFilePath();
  fs.writeFileSync(filePath, JSON.stringify(validated, null, 2));
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort hardening, as writeSettings */
    }
  }
}

/**
 * Change one provider's plain (non-secret) settings, e.g. `{ enabled: false }`,
 * leaving its key and every other provider as they are on disk.
 */
export function writeProviderSetting(providerId: string, patch: Record<string, string | number | boolean | null>): void {
  if ("apiKey" in patch || "serviceAccountKey" in patch) throw new Error("Keys go through writeProviderKey.");
  const raw = readRawSettingsFile();
  if (!raw) {
    writeSettings({ providerSettings: { [providerId]: patch } } as Partial<UserSettings>);
    return;
  }
  const providers = { ...((raw.providerSettings ?? {}) as Record<string, Record<string, unknown>>) };
  const entry: Record<string, unknown> = { ...(providers[providerId] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete entry[k];
    else entry[k] = v;
  }
  providers[providerId] = entry;
  const validated = UserSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...raw, providerSettings: providers });
  const filePath = getSettingsFilePath();
  fs.writeFileSync(filePath, JSON.stringify(validated, null, 2));
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort hardening, as writeSettings */
    }
  }
}

export function writeSettings(settings: Partial<UserSettings>): void {
  try {
    const filePath = getSettingsFilePath();
    const currentSettings = readSettingsFromFile();
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
        if (
          callerTouchedProviders &&
          settings.providerSettings?.[provider] != null
        )
          continue;
        const rawProvider = rawProviders[provider];
        if (rawProvider?.apiKey || rawProvider?.serviceAccountKey) {
          newSettings.providerSettings[provider] =
            rawProvider as UserSettings["providerSettings"][string];
        }
      }
    }
    const validatedSettings = UserSettingsSchema.parse(newSettings);
    // Keys this version doesn't know were written by a NEWER Atlarix on this
    // machine (the app and the CLI update separately): carried through, so
    // running an older build never erases a newer one's settings. 15.7.0 dropped
    // 15.7.1's consent version and MCP defaults this way (QA 15.7.1 #8).
    const known = UserSettingsSchema.shape;
    const carried = Object.fromEntries(
      Object.entries(raw ?? {}).filter(([k]) => !(k in known)),
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...carried, ...validatedSettings }, null, 2),
    );
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
    /**
     * Seeded false, then set by the provider loop below.
     *
     * This used to be `isPlain(s.githubAccessToken)` — the GitHub token was
     * simply the first secret in the file. Deleting that field could not just
     * delete this line: the variable is what decides whether the
     * plaintext→encrypted recovery runs at all, and it must still be reachable
     * for PROVIDER keys and the Vertex service-account key, which is the whole
     * remaining point of this function.
     */
    let hasPlaintext = false;
    for (const p in s.providerSettings ?? {}) {
      const ps = s.providerSettings[p] as {
        apiKey?: Secret;
      } & VertexProviderSetting;
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
  if (safeStorage?.isEncryptionAvailable()) {
    return {
      value: safeStorage.encryptString(data).toString("base64"),
      encryptionType: "electron-safe-storage",
    };
  }
  // A20/L-5: OS encryption unavailable (e.g. Linux without a Secret Service /
  // keyring) — the secret is persisted in cleartext. Warn once so this degraded
  // mode is visible in logs rather than silent. (Test builds intentionally use
  // plaintext and are not warned.)
  if (!warnedPlaintextSecret) {
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
    // Checked BEFORE the call rather than by matching on Electron's error text: the
    // string is not ours and a future Electron may reword it, at which point a
    // message-matching version of this would quietly go back to alarming everyone.
    if (isElectronAppReady() === false) {
      throw new SafeStorageNotReadyError();
    }
    return safeStorage.decryptString(Buffer.from(data.value, "base64"));
  }
  return data.value;
}
