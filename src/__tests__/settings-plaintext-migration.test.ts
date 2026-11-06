/**
 * Provider keys an older CLI left in PLAINTEXT get encrypted once the OS key
 * exists (11-06: on Windows with no desktop app the 15.12.5 CLI had no key and
 * wrote them unencrypted to user-settings.json). With no key at all (Linux
 * without a keyring) they stay, and one line says where.
 *
 * Every assertion is about the FILE on disk.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-plain-"));
vi.mock("@/paths/paths", () => ({ getUserDataPath: () => userDataDir }));

let available = true;
const fakeSafeStorage = {
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
  decryptString: (b: Buffer) => {
    const raw = b.toString("utf8");
    if (!raw.startsWith("enc:")) throw new Error("not decryptable");
    return raw.slice(4);
  },
};

const settingsPath = () => path.join(userDataDir, "user-settings.json");
const SECRET = "sk-ai4b-plain-0000000000000000abcd";

async function freshModule() {
  vi.resetModules();
  const mod = await import("@/main/settings");
  mod.__injectSafeStorageForTests(fakeSafeStorage as never);
  return mod;
}

function writeOldCliFile() {
  fs.writeFileSync(
    settingsPath(),
    JSON.stringify({
      selectedModel: { name: "auto", provider: "auto" },
      providerSettings: { openai: { apiKey: { value: SECRET, encryptionType: "plaintext" } } },
    }),
  );
}

beforeEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-plain-"));
  available = true;
});

describe("plaintext provider keys from an older CLI", () => {
  it("are rewritten encrypted once the OS key exists, and the plaintext leaves the file", async () => {
    writeOldCliFile();
    const s = await freshModule();
    expect(s.secureStoredSecrets()).toBeNull();
    const raw = fs.readFileSync(settingsPath(), "utf8");
    expect(raw).not.toContain(SECRET);
    const onDisk = JSON.parse(raw).providerSettings.openai.apiKey;
    expect(onDisk.encryptionType).toBe("electron-safe-storage");
    // Still the same key when read back.
    expect(s.readSettings().providerSettings.openai.apiKey?.value).toBe(SECRET);
    // No temp file left beside it (the write is atomic: temp, then rename).
    expect(fs.readdirSync(userDataDir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("with no OS key they stay, and one line names the file", async () => {
    available = false;
    writeOldCliFile();
    const s = await freshModule();
    const line = s.secureStoredSecrets();
    expect(line).toBe(`Provider keys are stored unencrypted in ${settingsPath()} (no OS keyring found).`);
    expect(fs.readFileSync(settingsPath(), "utf8")).toContain(SECRET);
  });

  it("nothing to do when nothing is plaintext", async () => {
    const s = await freshModule();
    expect(s.secureStoredSecrets()).toBeNull();
    available = false;
    expect(s.secureStoredSecrets()).toBeNull();
  });
});
