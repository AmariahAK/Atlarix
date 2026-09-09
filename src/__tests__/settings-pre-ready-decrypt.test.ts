/**
 * A settings read before `app.whenReady()` is not a keystore failure.
 *
 * THE REPORTED BUG
 * ----------------
 * Every launch of the packaged app logged:
 *
 *   settings: Could not decrypt one or more stored secrets right now (OS keystore
 *   busy, changed, or on a different machine)...
 *
 * with `Error: safeStorage cannot be used before app is ready` attached. Nothing was
 * wrong. `resolveSystemPath()` runs at module scope in `main.ts` — before ready — and
 * wants `customNodePath`, a PLAINTEXT field; getting it costs a full `readSettings()`,
 * which decrypts every stored secret on the way past.
 *
 * The important half is what must NOT happen: the ciphertext must survive untouched,
 * because a read that "fails" here is followed by a write in other code paths, and
 * that is how a recoverable moment becomes permanent credential loss.
 *
 * WHY THE INJECTORS AND NOT `vi.mock("electron")`. `settings.ts` reaches Electron
 * through `createRequire`, deliberately, so headless CI can import `readSettings` with
 * no Electron present — and a `vi.mock` of an ESM specifier does not intercept a CJS
 * require. Mocking it looks like it works and silently tests nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let userDataDir: string;

// One shared scope object. `log.scope("settings")` returns a NEW logger on every
// call, so spying on a second call's result asserts nothing — an earlier draft of
// this file "passed" that way, which is worse than failing.
const scopeLogger = {
  warn: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  silly: vi.fn(),
};
vi.mock("electron-log", () => {
  const scope = () => scopeLogger;
  return { default: { scope }, scope };
});

vi.mock("@/paths/paths", async (orig) => ({
  ...(await orig<typeof import("@/paths/paths")>()),
  getUserDataPath: () => userDataDir,
}));

/** A reversible stand-in for the OS primitive: this is about who writes what. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
  decryptString: (b: Buffer) => {
    const raw = b.toString("utf8");
    if (!raw.startsWith("enc:")) throw new Error("not decryptable");
    return raw.slice(4);
  },
};

const settingsPath = () => path.join(userDataDir, "user-settings.json");

function seedSettings(apiKeyCiphertext: string) {
  fs.writeFileSync(
    settingsPath(),
    JSON.stringify({
      providerSettings: {
        openai: {
          apiKey: {
            value: apiKeyCiphertext,
            encryptionType: "electron-safe-storage",
          },
        },
      },
    }),
    "utf8",
  );
}

const encrypted = (plain: string) =>
  Buffer.from(`enc:${plain}`, "utf8").toString("base64");

async function freshSettings(appIsReady: boolean) {
  vi.resetModules();
  const mod = await import("@/main/settings");
  mod.__injectSafeStorageForTests(fakeSafeStorage);
  mod.__injectAppReadyForTests(appIsReady);
  return mod;
}

describe("readSettings before the app is ready", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-settings-"));
    scopeLogger.warn.mockClear();
    scopeLogger.debug.mockClear();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("does not warn about the keystore when the app simply is not ready yet", async () => {
    seedSettings(encrypted("sk-the-real-key"));
    const { readSettings } = await freshSettings(false);

    readSettings();

    // The whole point of the fix. A warning here tells a user with a perfectly
    // healthy keystore that their keystore might be broken.
    expect(scopeLogger.warn).not.toHaveBeenCalled();
    // Not silence either — still visible when chasing something else.
    expect(scopeLogger.debug).toHaveBeenCalled();
  });

  it("leaves the stored ciphertext byte-for-byte intact", async () => {
    seedSettings(encrypted("sk-the-real-key"));
    const before = fs.readFileSync(settingsPath(), "utf8");
    const { readSettings } = await freshSettings(false);

    readSettings();

    // A failed read must never become a write. That progression — read returns
    // nothing, something persists the nothing — is how a busy keychain turned into
    // permanently lost API keys once already.
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe(before);
  });

  it("still decrypts normally once the app is ready", async () => {
    seedSettings(encrypted("sk-the-real-key"));
    const { readSettings } = await freshSettings(true);

    const settings = readSettings();

    // Proves the guard is scoped to the pre-ready window and did not simply
    // disable decryption.
    expect(settings.providerSettings?.openai?.apiKey?.value).toBe(
      "sk-the-real-key",
    );
    expect(scopeLogger.warn).not.toHaveBeenCalled();
  });

  it("still warns when the keystore itself fails after ready", async () => {
    // Ciphertext the stand-in cannot decrypt: a genuine keystore failure, which is
    // exactly the case the existing warning was written for.
    seedSettings(Buffer.from("garbage", "utf8").toString("base64"));
    const { readSettings } = await freshSettings(true);

    readSettings();

    expect(scopeLogger.warn).toHaveBeenCalled();
  });
});
