/**
 * The CLI's reimplementation of Electron safeStorage (Chromium OSCrypt). What
 * matters is byte compatibility with what the desktop app wrote, so the checks
 * decrypt with an INDEPENDENT implementation (openssl) where one exists, and
 * the macOS path runs against a throwaway keychain, never the user's.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cbcDecrypt,
  cbcEncrypt,
  cbcKey,
  createSafeStorage,
  gcmDecrypt,
  gcmEncrypt,
  desktopSafeStorage,
  macKeychainSource,
  windowsLocalStateSource,
} from "@/runtime/oscrypt";

describe("AES-128-CBC (macOS v10, Linux v11)", () => {
  it("matches an independent decryptor (openssl), IV of 16 spaces", () => {
    const key = cbcKey("peanuts", 1);
    const blob = cbcEncrypt(key, "v10", "sk-test-not-a-real-key");
    expect(blob.subarray(0, 3).toString()).toBe("v10");
    const plain = execFileSync(
      "openssl",
      ["enc", "-d", "-aes-128-cbc", "-K", key.toString("hex"), "-iv", "20".repeat(16)],
      { input: blob.subarray(3) },
    ).toString();
    expect(plain).toBe("sk-test-not-a-real-key");
  });

  it("derives the key as PBKDF2-SHA1(saltysalt, 16 bytes)", () => {
    expect(cbcKey("pw", 1003)).toEqual(crypto.pbkdf2Sync("pw", "saltysalt", 1003, 16, "sha1"));
  });

  it("round-trips", () => {
    const key = cbcKey("x", 1003);
    expect(cbcDecrypt(key, cbcEncrypt(key, "v10", "héllo"))).toBe("héllo");
  });
});

describe("AES-256-GCM (Windows v10)", () => {
  it("lays out v10 | nonce(12) | ciphertext | tag(16) and round-trips", () => {
    const key = crypto.randomBytes(32);
    const blob = gcmEncrypt(key, "abc");
    expect(blob.subarray(0, 3).toString()).toBe("v10");
    expect(blob.length).toBe(3 + 12 + 3 + 16);
    expect(gcmDecrypt(key, blob)).toBe("abc");
  });

  it("rejects a tampered value", () => {
    const key = crypto.randomBytes(32);
    const blob = gcmEncrypt(key, "abc");
    blob[20] ^= 1;
    expect(() => gcmDecrypt(key, blob)).toThrow();
  });
});

describe.runIf(process.platform === "darwin")("macOS keychain source", () => {
  // In beforeAll, not the describe body: vitest runs a skipped describe's body
  // to collect it, so setup here ran `security` on Linux CI (ENOENT).
  const dir = path.join(os.tmpdir(), `oscrypt-kc-${process.pid}-${Date.now()}`);
  const keychain = path.join(dir, "test.keychain-db");
  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("security", ["create-keychain", "-p", "test", keychain]);
    execFileSync("security", ["unlock-keychain", "-p", "test", keychain]);
  });
  afterAll(() => {
    try {
      execFileSync("security", ["delete-keychain", keychain]);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("with no item and create:false, encryption is unavailable", () => {
    const ss = createSafeStorage(macKeychainSource("AtlarixTest", { keychain }));
    expect(ss.isEncryptionAvailable()).toBe(false);
  });

  it("reads the item the desktop wrote and decrypts its values", () => {
    execFileSync("security", [
      "add-generic-password", "-s", "AtlarixTest2 Safe Storage", "-a", "AtlarixTest2 Key",
      "-w", "desktop-password", keychain,
    ]);
    // What the desktop app would have stored for a key.
    const desktopBlob = cbcEncrypt(cbcKey("desktop-password", 1003), "v10", "sk-from-desktop");
    const ss = createSafeStorage(macKeychainSource("AtlarixTest2", { keychain }));
    expect(ss.isEncryptionAvailable()).toBe(true);
    expect(ss.decryptString(desktopBlob)).toBe("sk-from-desktop");
    // And what the CLI writes, the desktop's key reads.
    expect(cbcDecrypt(cbcKey("desktop-password", 1003), ss.encryptString("sk-from-cli"))).toBe(
      "sk-from-cli",
    );
  });

  it("creates the item when the desktop never ran (create:true)", () => {
    const ss = createSafeStorage(macKeychainSource("AtlarixTest3", { keychain, create: true }));
    expect(ss.isEncryptionAvailable()).toBe(true);
    expect(ss.decryptString(ss.encryptString("x"))).toBe("x");
  });
});

/**
 * Windows with no desktop app (or the Store app, whose AppData lives in its
 * package): no "Local State", so the CLI and the editors had no key, could not
 * save their sign-in, and every new process asked again (11-06: Windows users
 * signing in 2-4 times in minutes, a new session each time). The CLI now makes
 * the key the way Chromium does, so a desktop app installed later adopts it.
 * DPAPI is faked here (XOR with a constant); the real one is PowerShell's.
 */
describe("Windows Local State source", () => {
  const fakeDpapi = {
    protect: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)),
    unprotect: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)),
  };
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "oscrypt-win-"));
    dirs.push(d);
    return d;
  };
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const localState = (d: string) => JSON.parse(fs.readFileSync(path.join(d, "Local State"), "utf8"));

  it("no Local State and create:false: unavailable, nothing written", () => {
    const d = tmp();
    const s = createSafeStorage(windowsLocalStateSource(d, { dpapi: fakeDpapi }));
    expect(s.isEncryptionAvailable()).toBe(false);
    expect(fs.existsSync(path.join(d, "Local State"))).toBe(false);
  });

  it("creates the key in Chromium's format; a second process reads the same key", () => {
    const d = tmp();
    const first = createSafeStorage(windowsLocalStateSource(d, { create: true, dpapi: fakeDpapi }));
    expect(first.isEncryptionAvailable()).toBe(true);
    const sealed = first.encryptString("session");
    const wrapped = Buffer.from(localState(d).os_crypt.encrypted_key, "base64");
    expect(wrapped.subarray(0, 5).toString()).toBe("DPAPI");
    expect(fakeDpapi.unprotect(wrapped.subarray(5))).toHaveLength(32);
    // The next CLI or editor process, and the desktop app if installed later.
    const second = createSafeStorage(windowsLocalStateSource(d, { dpapi: fakeDpapi }));
    expect(second.decryptString(sealed)).toBe("session");
  });

  it("keeps whatever else Local State holds", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "Local State"), JSON.stringify({ browser: { x: 1 }, os_crypt: { audit_enabled: true } }));
    createSafeStorage(windowsLocalStateSource(d, { create: true, dpapi: fakeDpapi })).isEncryptionAvailable();
    const st = localState(d);
    expect(st.browser).toEqual({ x: 1 });
    expect(st.os_crypt.audit_enabled).toBe(true);
    expect(typeof st.os_crypt.encrypted_key).toBe("string");
  });

  it("never replaces a key it cannot unwrap, or a file it cannot read", () => {
    const d = tmp();
    const theirs = JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), Buffer.from("x")]).toString("base64") } });
    fs.writeFileSync(path.join(d, "Local State"), theirs);
    const failing = { protect: fakeDpapi.protect, unprotect: () => null };
    expect(createSafeStorage(windowsLocalStateSource(d, { create: true, dpapi: failing })).isEncryptionAvailable()).toBe(false);
    expect(fs.readFileSync(path.join(d, "Local State"), "utf8")).toBe(theirs);

    const e = tmp();
    fs.writeFileSync(path.join(e, "Local State"), "{not json");
    expect(createSafeStorage(windowsLocalStateSource(e, { create: true, dpapi: fakeDpapi })).isEncryptionAvailable()).toBe(false);
    expect(fs.readFileSync(path.join(e, "Local State"), "utf8")).toBe("{not json");
  });

  it("the desktop's safeStorage on Windows creates the key", () => {
    const d = tmp();
    const s = desktopSafeStorage("Atlarix", d, { platform: "win32", dpapi: fakeDpapi });
    expect(s.isEncryptionAvailable()).toBe(true);
    expect(fs.existsSync(path.join(d, "Local State"))).toBe(true);
  });
});
