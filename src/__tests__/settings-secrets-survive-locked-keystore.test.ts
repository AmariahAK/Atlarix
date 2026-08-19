/**
 * Stored API keys must survive an OS keystore that is briefly unreadable.
 *
 * THE REPORTED BUG
 * ----------------
 * "I keep losing all my api keys." `readSettings` DELETED any secret it could
 * not decrypt, and `writeSettings` was built on `readSettings` — so the next
 * write of ANY unrelated setting (theme, zoom, selected model) persisted the
 * stripped object and erased the encrypted keys from disk. A transient condition
 * became a permanent one, and the warning text told the user to re-enter their
 * keys, which is the action that made the loss stick.
 *
 * Every assertion is about the FILE. A decrypted read returning nothing while the
 * keystore is busy is acceptable; the ciphertext leaving the disk is not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-settings-"));
/** Toggles the fake keystore. Decrypt throws while "locked", exactly as the real one does. */
let keystoreReadable = true;

vi.mock("@/paths/paths", () => ({ getUserDataPath: () => userDataDir }));
// This test used to force IS_TEST_BUILD=false so it exercised the shipped
// encrypted path rather than the build flag's plaintext short-circuit. That flag
// is gone — encryption is now unconditional — so the shipped path IS the default
// and no mock is needed. The assertions below are unchanged.

/** Stand-in for the OS keystore — reversible, and lockable on demand. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
  decryptString: (b: Buffer) => {
    if (!keystoreReadable) throw new Error("keystore is locked");
    const raw = b.toString("utf8");
    if (!raw.startsWith("enc:")) throw new Error("not decryptable");
    return raw.slice(4);
  },
};

const settingsPath = () => path.join(userDataDir, "user-settings.json");

async function freshModule() {
  vi.resetModules();
  const mod = await import("@/main/settings");
  mod.__injectSafeStorageForTests(fakeSafeStorage as never);
  return mod;
}

function readFileJson() {
  return JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
}

beforeEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-settings-"));
  keystoreReadable = true;
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe("provider secrets vs. a locked keystore", () => {
  it("keeps the stored API key when an unrelated setting is written while the keystore is locked", async () => {
    const { writeSettings } = await freshModule();
    writeSettings({
      providerSettings: {
        openai: { apiKey: { value: "sk-real-key", encryptionType: "plaintext" } },
      },
    });
    const stored = readFileJson().providerSettings.openai.apiKey;
    // On disk it is ciphertext, not the key — asserted so a regression that
    // starts writing plaintext fails here rather than quietly leaking.
    expect(stored.encryptionType).toBe("electron-safe-storage");
    expect(stored.value).not.toContain("sk-real-key");

    // Keystore goes unreadable, then the user changes their theme.
    keystoreReadable = false;
    const locked = await freshModule();
    locked.writeSettings({ selectedTheme: "dark" } as never);

    // THE ASSERTION THAT MATTERS: the ciphertext is still there.
    expect(readFileJson().providerSettings.openai.apiKey).toEqual(stored);
  });

  it("returns the key again once the keystore recovers", async () => {
    const { writeSettings } = await freshModule();
    writeSettings({
      providerSettings: {
        openai: { apiKey: { value: "sk-real-key", encryptionType: "plaintext" } },
      },
    });

    keystoreReadable = false;
    const locked = await freshModule();
    expect(locked.readSettings().providerSettings.openai?.apiKey).toBeUndefined();
    locked.writeSettings({ selectedTheme: "dark" } as never);

    keystoreReadable = true;
    const recovered = await freshModule();
    expect(recovered.readSettings().providerSettings.openai?.apiKey?.value).toBe(
      "sk-real-key",
    );
  });

  it("still honours an explicit key change", async () => {
    // The preservation rule must not make keys unremovable or unchangeable.
    const { writeSettings, readSettings } = await freshModule();
    writeSettings({
      providerSettings: {
        openai: { apiKey: { value: "old", encryptionType: "plaintext" } },
      },
    });
    writeSettings({
      providerSettings: {
        openai: { apiKey: { value: "new", encryptionType: "plaintext" } },
      },
    });
    expect(readSettings().providerSettings.openai?.apiKey?.value).toBe("new");
  });

  it("still honours an explicit key removal", async () => {
    const { writeSettings, readSettings } = await freshModule();
    writeSettings({
      providerSettings: {
        openai: { apiKey: { value: "doomed", encryptionType: "plaintext" } },
      },
    });
    writeSettings({ providerSettings: { openai: {} } });
    expect(readSettings().providerSettings.openai?.apiKey).toBeUndefined();
  });

  it("preserves a second provider's key while one is being changed", async () => {
    const { writeSettings } = await freshModule();
    writeSettings({
      providerSettings: {
        openai: { apiKey: { value: "openai-key", encryptionType: "plaintext" } },
        anthropic: { apiKey: { value: "anthropic-key", encryptionType: "plaintext" } },
      },
    });
    const anthropicBefore = readFileJson().providerSettings.anthropic.apiKey;

    keystoreReadable = false;
    const locked = await freshModule();
    locked.writeSettings({
      providerSettings: {
        openai: { apiKey: { value: "openai-rotated", encryptionType: "plaintext" } },
      },
    });

    // The untouched provider keeps its ciphertext even though nothing could read it.
    expect(readFileJson().providerSettings.anthropic.apiKey).toEqual(anthropicBefore);
  });
});
