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
  macKeychainSource,
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
