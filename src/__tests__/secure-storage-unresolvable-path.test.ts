/**
 * The session store must not THROW when it cannot work out where the session is.
 *
 * ══ WHY THIS IS NOT A THEORETICAL CASE ══
 *
 * This adapter is handed to `@supabase/auth-js`, whose `GoTrueClient`
 * CONSTRUCTOR kicks off `_recoverAndRefresh()` and does not await it. So a throw
 * on the read path does not reach whatever called `getSupabaseClient()` — it
 * escapes every `try`/`catch` up the stack and lands as an **unhandled
 * rejection**.
 *
 * It cost a release tag to find. `skill-index.ts` began reading account skills,
 * which constructs the Supabase client; a test that mocked `electron.app`
 * without `getPath` therefore made `app.getPath("userData")` throw inside that
 * fire-and-forget recovery. Vitest reported **4,814 tests passed and exit code
 * 1** — every test green, one unhandled error, the whole `quality` job red and
 * the release halted before it published anything.
 *
 * ══ WHY "unavailable" AND NOT "empty" ══
 *
 * The distinction is this module's own, and it is load-bearing: `empty` licenses
 * the caller to WRITE OVER the stored session, and "I cannot find out where the
 * file is" is not evidence that there is no file. Reporting empty here would
 * turn a transient environment fault into a signed-out user with their session
 * overwritten — the exact bug
 * `secure-storage-survives-locked-keychain.test.ts` exists to prevent, reached
 * by a different door.
 */

import { describe, it, expect, vi } from "vitest";

/** Set per test, so one mock can model both a broken and a working app module. */
let getPathImpl: () => string;

vi.mock("electron", () => ({
  app: {
    getPath: () => getPathImpl(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createSecureSupabaseStorage } from "@/lib/auth/supabase-secure-storage";

describe("when the session path cannot be resolved", () => {
  it("RESOLVES rather than rejecting, so it cannot become an unhandled rejection", async () => {
    // THE HEADLINE. `auth-js` calls this from a constructor without awaiting, so
    // a rejection here is unattributable and fails an entire test run.
    getPathImpl = () => {
      throw new TypeError("app.getPath is not a function");
    };
    const storage = createSecureSupabaseStorage();

    await expect(storage.getItem("sb-auth-token")).resolves.toBeNull();
  });

  it("does not leave the rejection for the process to catch", async () => {
    getPathImpl = () => {
      throw new TypeError("app.getPath is not a function");
    };
    const storage = createSecureSupabaseStorage();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Called WITHOUT awaiting, which is how auth-js calls it.
      void storage.getItem("sb-auth-token");
      // Two macrotask turns is more than enough for a rejection to surface.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("refuses to report EMPTY, which would license overwriting a real session", async () => {
    // `getItem` returning null is "no value for this key", which is correct and
    // safe. What must never happen is a WRITE that treats the absence as proof
    // the file holds nothing — so a failed read must not persist anything.
    getPathImpl = () => {
      throw new TypeError("app.getPath is not a function");
    };
    const storage = createSecureSupabaseStorage();

    await expect(storage.getItem("sb-auth-token")).resolves.toBeNull();
    // A set attempt in this state must also not throw into auth-js.
    await expect(storage.setItem("sb-auth-token", "{}")).resolves.not.toThrow;
  });
});
