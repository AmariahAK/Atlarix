/**
 * The stored session must survive a keychain that is briefly unavailable.
 *
 * THE REPORTED BUG
 * ----------------
 * "I didn't sign out so why does the app log me out when I close it" — plus API
 * keys disappearing. One root cause: `safeStorage.isEncryptionAvailable()` can be
 * false for a moment around launch, and the storage layer treated that as "there
 * is no session". Three separate steps then turned a recoverable condition into a
 * permanent one:
 *
 *   1. an existing `supabase-auth.enc` was SKIPPED and `{}` returned,
 *   2. that `{}` was CACHED, which silently defeated the 400 ms retry
 *      `restoreAuthSessionOnStartup` performs for exactly this case (it re-read a
 *      cache instead of the disk), and
 *   3. the next `setItem`/`removeItem` persisted the `{}` OVER the real file.
 *
 * Every assertion here is about the BYTES ON DISK, not the return value. A read
 * returning nothing while the keychain is busy is acceptable; the file being
 * destroyed is not, and only the file can tell those apart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let userDataDir: string;
let encryptionAvailable = true;
/** Flips to true once the app has asked at least once — models "busy at launch, fine later". */
let availabilityChecks = 0;

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => {
      availabilityChecks++;
      return encryptionAvailable;
    },
    // A reversible stand-in for the OS primitive: the test cares about who
    // writes what, not about real crypto.
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => {
      const raw = b.toString("utf8");
      if (!raw.startsWith("enc:")) throw new Error("not decryptable");
      return raw.slice(4);
    },
  },
}));

const encPath = () => path.join(userDataDir, "supabase-auth.enc");

async function freshModule() {
  vi.resetModules();
  return await import("@/lib/auth/supabase-secure-storage");
}

/** Write a session file the way a healthy app would have left one. */
function seedStoredSession(value = "the-real-session") {
  const json = JSON.stringify({ "sb-auth-token": value });
  fs.writeFileSync(encPath(), Buffer.from(`enc:${json}`, "utf8").toString("base64"), "utf8");
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-secure-storage-"));
  encryptionAvailable = true;
  availabilityChecks = 0;
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe("session storage vs. an unavailable keychain", () => {
  it("does NOT erase the session file when the keychain is busy at read and fine at write", async () => {
    // THE data-loss sequence, and the one worth writing carefully. A first draft
    // of this test held encryption unavailable for the whole run — and PASSED
    // against the broken code, because the old `persistBlob` also refused to
    // write while unavailable, so the file survived by accident.
    //
    // The real launch looks like this: keychain busy for a moment (read fails,
    // `{}` cached), keychain fine a second later, app writes any key at all —
    // and `{}` goes over the session.
    seedStoredSession();
    const before = fs.readFileSync(encPath(), "utf8");
    encryptionAvailable = false;

    const { createSecureSupabaseStorage } = await freshModule();
    const storage = createSecureSupabaseStorage();
    expect(await storage.getItem("sb-auth-token")).toBeNull();

    encryptionAvailable = true;
    await storage.removeItem("some-other-key");

    expect(fs.existsSync(encPath())).toBe(true);
    expect(fs.readFileSync(encPath(), "utf8")).toBe(before);
  });

  it("recovers the session once the keychain comes back — the retry actually retries", async () => {
    // The exact defeat of the v13.9 hardening: the first read failed, `{}` was
    // cached, and the 400 ms retry above never touched the disk again.
    seedStoredSession("session-worth-keeping");
    encryptionAvailable = false;

    const { createSecureSupabaseStorage } = await freshModule();
    const storage = createSecureSupabaseStorage();

    expect(await storage.getItem("sb-auth-token")).toBeNull();

    encryptionAvailable = true;
    expect(await storage.getItem("sb-auth-token")).toBe("session-worth-keeping");
  });

  it("reports a genuinely absent session as absent", async () => {
    // The fix must not make everyone look signed in forever.
    const { createSecureSupabaseStorage } = await freshModule();
    const storage = createSecureSupabaseStorage();
    expect(await storage.getItem("sb-auth-token")).toBeNull();
    expect(fs.existsSync(encPath())).toBe(false);
  });

  it("still lets a real sign-in write a session", async () => {
    const { createSecureSupabaseStorage } = await freshModule();
    const storage = createSecureSupabaseStorage();
    await storage.setItem("sb-auth-token", "brand-new");
    expect(fs.existsSync(encPath())).toBe(true);
    expect(await storage.getItem("sb-auth-token")).toBe("brand-new");
  });

  it("still lets an explicit sign-out delete everything", async () => {
    // The empty-write guard must not make sign-out a no-op.
    seedStoredSession();
    const { clearSupabaseSecureStorage, createSecureSupabaseStorage } =
      await freshModule();
    await clearSupabaseSecureStorage();
    expect(fs.existsSync(encPath())).toBe(false);
    expect(await createSecureSupabaseStorage().getItem("sb-auth-token")).toBeNull();
  });

  it("retries availability rather than trusting one early check", async () => {
    seedStoredSession();
    encryptionAvailable = false;
    const { createSecureSupabaseStorage } = await freshModule();
    await createSecureSupabaseStorage().getItem("sb-auth-token");
    // More than one probe — a single false reading must not decide the outcome.
    expect(availabilityChecks).toBeGreaterThan(1);
  });

  it("keeps the legacy plaintext file when it cannot be re-encrypted", async () => {
    // Migration used to unlink the legacy file unconditionally, including after
    // a failed encrypt — deleting the only remaining copy.
    const legacy = path.join(userDataDir, "supabase-auth.json");
    fs.writeFileSync(legacy, JSON.stringify({ "sb-auth-token": "legacy" }), "utf8");
    encryptionAvailable = false;

    const { createSecureSupabaseStorage } = await freshModule();
    expect(await createSecureSupabaseStorage().getItem("sb-auth-token")).toBe("legacy");
    expect(fs.existsSync(legacy)).toBe(true);
  });
});
