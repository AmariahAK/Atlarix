/**
 * Secure storage for Supabase auth session (keychain / safeStorage fallback).
 * Migrates legacy plaintext supabase-auth.json once, then deletes it.
 */

import type { SupportedStorage } from "@supabase/supabase-js";
import log from "electron-log";
import { app, safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";

const logger = log.scope("supabase-secure-storage");

const KEYTAR_SERVICE = "Atlarix";
const KEYTAR_ACCOUNT = "supabase-auth-session";

function legacyJsonPath(): string {
  return path.join(app.getPath("userData"), "supabase-auth.json");
}

function fallbackEncryptedPath(): string {
  return path.join(app.getPath("userData"), "supabase-auth.enc");
}

let storageCache: Record<string, string> | null = null;
let loadPromise: Promise<Record<string, string>> | null = null;

/** Native module: use createRequire so Vite/esbuild does not bundle `.node` binaries. */
type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

function getKeytarModule(): KeytarModule | null {
  try {
    const req = createRequire(import.meta.url);
    const loaded = req("keytar") as KeytarModule & { default?: KeytarModule };
    if (typeof loaded.getPassword === "function") return loaded;
    if (loaded.default && typeof loaded.default.getPassword === "function") {
      return loaded.default;
    }
    return null;
  } catch {
    return null;
  }
}

async function readBlobFromDisk(): Promise<Record<string, string>> {
  const kt = getKeytarModule();
  if (kt) {
    try {
      const raw = await kt.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string>;
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch (e) {
      logger.warn("[SupabaseSecureStorage] keytar read failed:", e);
    }
  }

  const encPath = fallbackEncryptedPath();
  try {
    if (fs.existsSync(encPath)) {
      const b64 = fs.readFileSync(encPath, "utf8");
      if (safeStorage.isEncryptionAvailable()) {
        const buf = Buffer.from(b64, "base64");
        const json = safeStorage.decryptString(buf);
        return JSON.parse(json) as Record<string, string>;
      }
    }
  } catch (e) {
    logger.warn("[SupabaseSecureStorage] encrypted file read failed:", e);
  }

  const legacy = legacyJsonPath();
  try {
    if (fs.existsSync(legacy)) {
      const data = fs.readFileSync(legacy, "utf8");
      const parsed = JSON.parse(data) as Record<string, string>;
      if (parsed && typeof parsed === "object") {
        await persistBlob(parsed);
        try {
          fs.unlinkSync(legacy);
          logger.log("[SupabaseSecureStorage] Migrated legacy supabase-auth.json and removed file");
        } catch {
          /* ignore */
        }
        return parsed;
      }
    }
  } catch (e) {
    logger.warn("[SupabaseSecureStorage] legacy json read failed:", e);
  }

  return {};
}

async function persistBlob(cache: Record<string, string>): Promise<void> {
  const json = JSON.stringify(cache);
  const kt = getKeytarModule();
  if (kt) {
    try {
      await kt.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, json);
      try {
        if (fs.existsSync(fallbackEncryptedPath())) fs.unlinkSync(fallbackEncryptedPath());
      } catch {
        /* ignore */
      }
      return;
    } catch (e) {
      logger.warn("[SupabaseSecureStorage] keytar write failed, using encrypted file:", e);
    }
  }

  if (safeStorage.isEncryptionAvailable()) {
    // safeStorage is a native module; encryptString can throw at the C++ level
    // (e.g. OS credential store locked). Guard it so the throw can't bubble
    // uncaught and abort the main process (the keytar branch above is wrapped too).
    try {
      const enc = safeStorage.encryptString(json);
      fs.writeFileSync(fallbackEncryptedPath(), enc.toString("base64"), "utf8");
    } catch (e) {
      logger.error("[SupabaseSecureStorage] safeStorage encrypt/write failed:", e);
    }
    return;
  }

  logger.error("[SupabaseSecureStorage] No secure storage available; session not persisted securely");
}

async function ensureLoaded(): Promise<Record<string, string>> {
  if (storageCache !== null) return storageCache;
  if (!loadPromise) {
    loadPromise = readBlobFromDisk().then((blob) => {
      storageCache = blob;
      return blob;
    });
  }
  storageCache = await loadPromise;
  return storageCache;
}

export function createSecureSupabaseStorage(): SupportedStorage {
  return {
    getItem: async (key: string) => {
      const cache = await ensureLoaded();
      return cache[key] ?? null;
    },
    setItem: async (key: string, value: string) => {
      const cache = await ensureLoaded();
      cache[key] = value;
      storageCache = cache;
      await persistBlob(cache);
    },
    removeItem: async (key: string) => {
      const cache = await ensureLoaded();
      delete cache[key];
      storageCache = cache;
      await persistBlob(cache);
    },
  };
}

/**
 * Wipe all persisted Supabase auth data (explicit logout).
 */
export async function clearSupabaseSecureStorage(): Promise<void> {
  storageCache = {};
  loadPromise = null;
  const kt = getKeytarModule();
  if (kt) {
    try {
      await kt.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    } catch {
      /* ignore */
    }
  }
  try {
    if (fs.existsSync(fallbackEncryptedPath())) fs.unlinkSync(fallbackEncryptedPath());
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(legacyJsonPath())) fs.unlinkSync(legacyJsonPath());
  } catch {
    /* ignore */
  }
  logger.log("[SupabaseSecureStorage] Cleared all persisted auth");
}
