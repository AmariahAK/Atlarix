/**
 * Electron `safeStorage`, reimplemented for the CLI, so the CLI reads and writes
 * the SAME encrypted secrets the desktop app does (provider keys in
 * user-settings.json, MCP credentials in the database).
 *
 * Electron's safeStorage is Chromium's OSCrypt. The format, per platform:
 *
 *   macOS    "v10" + AES-128-CBC(key, iv = 16 spaces, PKCS#7). The key is
 *            PBKDF2-SHA1(password, "saltysalt", 1003 iterations, 16 bytes); the
 *            password is the keychain item "<App> Safe Storage" / "<App> Key".
 *   Windows  "v10" + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag. The
 *            key is `os_crypt.encrypted_key` in "<userData>/Local State":
 *            base64, "DPAPI" prefix, protected with DPAPI for the current user.
 *   Linux    "v11" with a key from the Secret Service, as macOS but 1 iteration.
 *            Best-effort: if the password cannot be found, encryption reports
 *            itself unavailable and settings.ts falls back exactly as it does in
 *            the desktop on a keyring-less Linux.
 *
 * Reading the macOS keychain item from a program other than the desktop app
 * makes macOS ask the user once (they can choose "Always Allow").
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const SALT = "saltysalt";
const IV_CBC = Buffer.alloc(16, 0x20);

// ─── macOS / Linux: AES-128-CBC ──────────────────────────────────────────────

export function cbcKey(password: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, SALT, iterations, 16, "sha1");
}

export function cbcEncrypt(key: Buffer, prefix: "v10" | "v11", plain: string): Buffer {
  const c = crypto.createCipheriv("aes-128-cbc", key, IV_CBC);
  return Buffer.concat([Buffer.from(prefix), c.update(plain, "utf8"), c.final()]);
}

export function cbcDecrypt(key: Buffer, data: Buffer): string {
  const d = crypto.createDecipheriv("aes-128-cbc", key, IV_CBC);
  return Buffer.concat([d.update(data.subarray(3)), d.final()]).toString("utf8");
}

// ─── Windows: AES-256-GCM ────────────────────────────────────────────────────

export function gcmEncrypt(key: Buffer, plain: string): Buffer {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, body, c.getAuthTag()]);
}

export function gcmDecrypt(key: Buffer, data: Buffer): string {
  const nonce = data.subarray(3, 15);
  const tag = data.subarray(data.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data.subarray(15, data.length - 16)), d.final()]).toString(
    "utf8",
  );
}

// ─── Where the key comes from ────────────────────────────────────────────────

export interface KeySource {
  /** The key for "v10" (macOS, Windows) / "v11" (Linux), or null when unavailable. */
  load(): Buffer | null;
  prefix: "v10" | "v11";
  mode: "cbc" | "gcm";
}

/** macOS keychain. `keychain` targets a specific keychain file (tests). */
export function macKeychainSource(
  appName: string,
  opts: { keychain?: string; create?: boolean } = {},
): KeySource {
  const service = `${appName} Safe Storage`;
  const account = `${appName} Key`;
  const where = opts.keychain ? [opts.keychain] : [];
  return {
    prefix: "v10",
    mode: "cbc",
    load() {
      try {
        const pw = execFileSync(
          "security",
          ["find-generic-password", "-s", service, "-a", account, "-w", ...where],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trimEnd();
        return cbcKey(pw, 1003);
      } catch {
        if (!opts.create) return null;
      }
      // No item yet: the desktop app has never run on this machine. Create it
      // the way Chromium does (random password) so the desktop adopts it later.
      const pw = crypto.randomBytes(16).toString("base64");
      try {
        execFileSync(
          "security",
          ["add-generic-password", "-s", service, "-a", account, "-w", pw, ...where],
          { stdio: "ignore" },
        );
        return cbcKey(pw, 1003);
      } catch {
        return null;
      }
    },
  };
}

/** Windows: DPAPI-protected key in Chromium's Local State. */
export function windowsLocalStateSource(userDataDir: string): KeySource {
  return {
    prefix: "v10",
    mode: "gcm",
    load() {
      try {
        const state = JSON.parse(
          fs.readFileSync(path.join(userDataDir, "Local State"), "utf8"),
        ) as { os_crypt?: { encrypted_key?: string } };
        const wrapped = Buffer.from(state.os_crypt?.encrypted_key ?? "", "base64");
        if (wrapped.subarray(0, 5).toString() !== "DPAPI") return null;
        // The blob is DPAPI-protected: passing it on a command line reveals
        // nothing. The unwrapped key only ever exists in this process.
        const script =
          "Add-Type -AssemblyName System.Security; " +
          "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect(" +
          `[Convert]::FromBase64String('${wrapped.subarray(5).toString("base64")}'), $null, 'CurrentUser'))`;
        const out = execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        const key = Buffer.from(out, "base64");
        return key.length === 32 ? key : null;
      } catch {
        return null;
      }
    },
  };
}

/** Linux Secret Service via `secret-tool`, the schema Chromium uses. */
export function linuxSecretServiceSource(appName: string): KeySource {
  return {
    prefix: "v11",
    mode: "cbc",
    load() {
      try {
        const pw = execFileSync(
          "secret-tool",
          ["lookup", "application", appName.toLowerCase()],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trimEnd();
        return pw ? cbcKey(pw, 1) : null;
      } catch {
        return null;
      }
    },
  };
}

export function createSafeStorage(source: KeySource): SafeStorageLike {
  let key: Buffer | null | undefined;
  const getKey = () => (key === undefined ? (key = source.load()) : key);
  return {
    isEncryptionAvailable: () => getKey() !== null,
    encryptString(plain) {
      const k = getKey();
      if (!k) throw new Error("OS encryption is unavailable");
      return source.mode === "gcm" ? gcmEncrypt(k, plain) : cbcEncrypt(k, source.prefix, plain);
    },
    decryptString(data) {
      const k = getKey();
      if (!k) throw new Error("OS encryption is unavailable");
      const prefix = data.subarray(0, 3).toString();
      if (prefix !== source.prefix) {
        throw new Error(`Unsupported encrypted value (${prefix}); expected ${source.prefix}`);
      }
      return source.mode === "gcm" ? gcmDecrypt(k, data) : cbcDecrypt(k, data);
    },
  };
}

/** The desktop app's safeStorage, for this platform. */
export function desktopSafeStorage(appName: string, userDataDir: string): SafeStorageLike {
  const source =
    process.platform === "darwin"
      ? macKeychainSource(appName, { create: true })
      : process.platform === "win32"
        ? windowsLocalStateSource(userDataDir)
        : linuxSecretServiceSource(appName);
  return createSafeStorage(source);
}
