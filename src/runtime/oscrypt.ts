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
/**
 * The OS key tools (security, secret-tool, powershell) never get longer than
 * this: with no keyring daemon (a headless box over SSH) secret-tool can wait
 * on D-Bus, and a sign-in must not hang on it.
 */
const KEY_TOOL_TIMEOUT_MS = 10_000;
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

/** DPAPI for the current user: wrap and unwrap a key. Null when it fails. */
export interface Dpapi {
  protect(plain: Buffer): Buffer | null;
  unprotect(sealed: Buffer): Buffer | null;
}

/** Windows' own DPAPI through PowerShell. Bytes go over stdin, never on a command line. */
export const powershellDpapi: Dpapi = {
  protect: (plain) => dpapiCall("Protect", plain),
  unprotect: (sealed) => dpapiCall("Unprotect", sealed),
};

function dpapiCall(op: "Protect" | "Unprotect", input: Buffer): Buffer | null {
  try {
    const script =
      "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadLine(); " +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}(` +
      "[Convert]::FromBase64String($in), $null, 'CurrentUser'))";
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      input: `${input.toString("base64")}\n`,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: KEY_TOOL_TIMEOUT_MS,
    }).trim();
    return out ? Buffer.from(out, "base64") : null;
  } catch {
    return null;
  }
}

/**
 * Windows: DPAPI-protected key in Chromium's Local State.
 *
 * `create`: with no key in Local State (the desktop app never ran here, or it
 * is the Store app, whose AppData lives in its package), make one the way
 * Chromium does: 32 random bytes, DPAPI-wrapped, stored as
 * `os_crypt.encrypted_key = base64("DPAPI" + blob)`, merged into whatever the
 * file already holds and written atomically. Chromium keeps a key it finds
 * there, so a desktop app installed later uses the same one. A key that is
 * there but will not unwrap (another user's), or a file that is not JSON, is
 * never replaced: that would lose the desktop's secrets.
 */
export function windowsLocalStateSource(
  userDataDir: string,
  opts: { create?: boolean; dpapi?: Dpapi } = {},
): KeySource {
  const dpapi = opts.dpapi ?? powershellDpapi;
  const file = path.join(userDataDir, "Local State");
  const read = (): { state: Record<string, unknown> } | "unreadable" | "absent" => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return "absent";
    }
    try {
      const state = JSON.parse(text) as unknown;
      return state && typeof state === "object" && !Array.isArray(state)
        ? { state: state as Record<string, unknown> }
        : "unreadable";
    } catch {
      return "unreadable";
    }
  };
  const keyIn = (state: Record<string, unknown>): string | undefined => {
    const k = (state.os_crypt as { encrypted_key?: unknown } | undefined)?.encrypted_key;
    return typeof k === "string" && k ? k : undefined;
  };
  const unwrap = (encoded: string): Buffer | null => {
    const wrapped = Buffer.from(encoded, "base64");
    if (wrapped.subarray(0, 5).toString() !== "DPAPI") return null;
    const key = dpapi.unprotect(wrapped.subarray(5));
    return key && key.length === 32 ? key : null;
  };
  return {
    prefix: "v10",
    mode: "gcm",
    load() {
      try {
        const got = read();
        if (got === "unreadable") return null;
        const existing = got === "absent" ? undefined : keyIn(got.state);
        if (existing) return unwrap(existing);
        if (!opts.create) return null;
        const key = crypto.randomBytes(32);
        const sealed = dpapi.protect(key);
        if (!sealed) return null;
        const state = got === "absent" ? {} : got.state;
        const osCrypt = (state.os_crypt && typeof state.os_crypt === "object" ? state.os_crypt : {}) as Record<string, unknown>;
        const next = {
          ...state,
          os_crypt: { ...osCrypt, encrypted_key: Buffer.concat([Buffer.from("DPAPI"), sealed]).toString("base64") },
        };
        fs.mkdirSync(userDataDir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next));
        fs.renameSync(tmp, file);
        // Another process (the desktop app starting, a second CLI) may have
        // written its own key at the same moment: use whatever is there now.
        const after = read();
        const now = after === "absent" || after === "unreadable" ? undefined : keyIn(after.state);
        return now ? unwrap(now) : null;
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
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: KEY_TOOL_TIMEOUT_MS },
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
export function desktopSafeStorage(
  appName: string,
  userDataDir: string,
  opts: { platform?: NodeJS.Platform; dpapi?: Dpapi } = {},
): SafeStorageLike {
  const platform = opts.platform ?? process.platform;
  // macOS and Windows create the key when the desktop never ran (Chromium
  // adopts it). Linux only reads it: a key stored by secret-tool would not be
  // the one Chromium's libsecret schema finds, so the two would disagree.
  const source =
    platform === "darwin"
      ? macKeychainSource(appName, { create: true })
      : platform === "win32"
        ? windowsLocalStateSource(userDataDir, { create: true, dpapi: opts.dpapi })
        : linuxSecretServiceSource(appName);
  return createSafeStorage(source);
}
