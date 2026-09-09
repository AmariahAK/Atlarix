/**
 * Secure storage for Supabase auth session (Electron safeStorage-backed).
 * Migrates legacy plaintext supabase-auth.json once, then deletes it.
 *
 * NOTE: This intentionally does NOT use keytar. keytar's prebuilt native binary
 * throws an uncaught C++ Napi::Error on the main thread for certain macOS
 * Keychain states, which std::terminate-aborts the whole app (no JS try/catch
 * can catch it). safeStorage is Electron core and raises catchable JS errors.
 */

import type { SupportedStorage } from "@supabase/supabase-js";
import log from "electron-log";
import { app, safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";

const logger = log.scope("supabase-secure-storage");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function legacyJsonPath(): string {
  return path.join(app.getPath("userData"), "supabase-auth.json");
}

function fallbackEncryptedPath(): string {
  return path.join(app.getPath("userData"), "supabase-auth.enc");
}

let storageCache: Record<string, string> | null = null;
let loadPromise: Promise<Record<string, string> | null> | null = null;

/**
 * Outcome of a disk read. The distinction between the last two is the whole bug:
 * "there is no session" and "I could not read the session just now" used to be
 * the same value (`{}`), and the app cannot tell a signed-out user from a locked
 * keychain if the layer below hands it the same answer for both.
 */
type BlobRead =
  | { status: "loaded"; blob: Record<string, string> }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * `safeStorage.isEncryptionAvailable()` is not stable the instant the app
 * launches — the OS credential store can still be coming up. The auth layer
 * above already retries `getSession()` once after 400 ms for exactly this
 * reason; without a retry HERE that one was useless, because a failed read was
 * cached and the retry never touched the disk again.
 */
async function encryptionAvailableWithRetry(): Promise<boolean> {
  if (safeStorage.isEncryptionAvailable()) return true;
  for (const delay of [50, 150, 400]) {
    await sleep(delay);
    if (safeStorage.isEncryptionAvailable()) {
      logger.log(
        `[SupabaseSecureStorage] Encryption became available after ${delay}ms — the first check was early, not a signed-out user`,
      );
      return true;
    }
  }
  return false;
}

async function readBlobFromDisk(): Promise<BlobRead> {
  const encPath = fallbackEncryptedPath();
  let encFileExists = false;
  try {
    encFileExists = fs.existsSync(encPath);
    if (encFileExists) {
      const b64 = fs.readFileSync(encPath, "utf8");
      if (await encryptionAvailableWithRetry()) {
        const buf = Buffer.from(b64, "base64");
        const json = safeStorage.decryptString(buf);
        return {
          status: "loaded",
          blob: JSON.parse(json) as Record<string, string>,
        };
      }
      // The session IS here; we just cannot open it right now. Saying "empty"
      // would present a signed-in user as signed out AND license the caller to
      // overwrite this file with nothing.
      logger.warn(
        "[SupabaseSecureStorage] Session file present but encryption unavailable — reporting UNAVAILABLE, not empty. Nothing will be overwritten.",
      );
      return { status: "unavailable" };
    }
  } catch (e) {
    logger.warn("[SupabaseSecureStorage] encrypted file read failed:", e);
    // A file that exists and fails to parse/decrypt is still not an absence.
    if (encFileExists) return { status: "unavailable" };
  }

  const legacy = legacyJsonPath();
  try {
    if (fs.existsSync(legacy)) {
      const data = fs.readFileSync(legacy, "utf8");
      const parsed = JSON.parse(data) as Record<string, string>;
      if (parsed && typeof parsed === "object") {
        const persisted = await persistBlob(parsed);
        // Only drop the legacy file once its replacement is actually on disk —
        // deleting it after a failed encrypt would destroy the only copy.
        if (persisted) {
          try {
            fs.unlinkSync(legacy);
            logger.log(
              "[SupabaseSecureStorage] Migrated legacy supabase-auth.json and removed file",
            );
          } catch {
            /* ignore */
          }
        } else {
          logger.warn(
            "[SupabaseSecureStorage] Legacy session could not be re-encrypted — KEEPING supabase-auth.json so the session is not lost",
          );
        }
        return { status: "loaded", blob: parsed };
      }
    }
  } catch (e) {
    logger.warn("[SupabaseSecureStorage] legacy json read failed:", e);
  }

  return { status: "empty" };
}

/** @returns whether the blob actually reached disk. */
async function persistBlob(cache: Record<string, string>): Promise<boolean> {
  // NEVER let an empty in-memory cache erase a session file that exists.
  //
  // This was the second half of the "closing the app logs me out" bug: a read
  // that failed returned `{}`, that `{}` was cached, and the next setItem or
  // removeItem wrote it straight over `supabase-auth.enc`. A recoverable
  // condition (keychain busy) became a permanent one (session destroyed).
  // Clearing auth is a deliberate act and has its own path —
  // `clearSupabaseSecureStorage()`.
  if (Object.keys(cache).length === 0) {
    try {
      if (fs.existsSync(fallbackEncryptedPath())) {
        logger.warn(
          "[SupabaseSecureStorage] Refusing to overwrite the stored session with an empty blob (use clearSupabaseSecureStorage to sign out).",
        );
        return false;
      }
    } catch {
      /* stat failed — fall through and let the write attempt decide */
    }
  }

  const json = JSON.stringify(cache);

  if (await encryptionAvailableWithRetry()) {
    // safeStorage is a native module; encryptString can throw at the C++ level
    // (e.g. OS credential store locked). Guard it so the throw can't bubble
    // uncaught and abort the main process.
    try {
      const enc = safeStorage.encryptString(json);
      fs.writeFileSync(fallbackEncryptedPath(), enc.toString("base64"), "utf8");
      return true;
    } catch (e) {
      logger.error(
        "[SupabaseSecureStorage] safeStorage encrypt/write failed:",
        e,
      );
      return false;
    }
  }

  // Reported symptom: sign in, close the app, and you are signed out — because
  // the session was never written. Say so at a level someone will see.
  logger.error(
    "[SupabaseSecureStorage] No secure storage available — the session was NOT saved and will not survive a restart. This is an OS keychain problem, not a sign-out.",
  );
  return false;
}

async function ensureLoaded(): Promise<Record<string, string>> {
  if (storageCache !== null) return storageCache;
  if (!loadPromise) {
    loadPromise = readBlobFromDisk().then((read) => {
      // Cache ONLY a definitive answer. Caching a failed read is what defeated
      // the 400 ms retry in `restoreAuthSessionOnStartup`: it re-read this
      // layer, got the cached `{}` without touching the disk, and concluded the
      // user was signed out. An "unavailable" read stays uncached so the next
      // caller genuinely retries.
      if (read.status === "unavailable") {
        loadPromise = null;
        return null;
      }
      storageCache = read.status === "loaded" ? read.blob : {};
      return storageCache;
    });
  }
  const loaded = await loadPromise;
  if (loaded === null) {
    // Undecryptable right now — report nothing WITHOUT committing to it. The
    // caller sees no session; the file on disk is untouched and readable later.
    return {};
  }
  storageCache = loaded;
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
  try {
    if (fs.existsSync(fallbackEncryptedPath()))
      fs.unlinkSync(fallbackEncryptedPath());
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
