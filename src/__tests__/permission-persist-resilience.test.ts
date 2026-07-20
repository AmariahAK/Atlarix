/**
 * Regression for Sentry 49d4f2a5: a disk-full `SqliteError: unable to open
 * database file` thrown from an "always allow" preference write must NOT wedge
 * the approval or throw out of IPC. Persisting a preference is best-effort.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the OS-notification surface so we can assert the storage-full notice.
// `vi.hoisted` so the spy exists before the hoisted `vi.mock` factory runs.
const { showAgentNotification } = vi.hoisted(() => ({
  showAgentNotification: vi.fn(async () => {}),
}));
vi.mock("@/main/agent-notification", () => ({ showAgentNotification }));

import {
  isStorageCapacityError,
  persistPermissionPreferenceSafely,
  __resetStorageWarningDebounce,
} from "@/ipc/handlers/permissions/persist-safe";

function cantopen(): Error {
  const e = new Error("unable to open database file") as Error & { code: string };
  e.code = "SQLITE_CANTOPEN";
  return e;
}

beforeEach(() => {
  showAgentNotification.mockClear();
  __resetStorageWarningDebounce();
});

afterEach(() => vi.clearAllMocks());

describe("isStorageCapacityError", () => {
  it("matches SQLITE_CANTOPEN / SQLITE_FULL / ENOSPC by code", () => {
    for (const code of ["SQLITE_CANTOPEN", "SQLITE_FULL", "ENOSPC"]) {
      const e = Object.assign(new Error("x"), { code });
      expect(isStorageCapacityError(e)).toBe(true);
    }
  });

  it("matches by message when code is absent", () => {
    expect(isStorageCapacityError(new Error("unable to open database file"))).toBe(true);
    expect(isStorageCapacityError(new Error("ENOSPC: no space left on device"))).toBe(true);
  });

  it("does NOT match ordinary errors", () => {
    expect(isStorageCapacityError(new Error("constraint failed"))).toBe(false);
    expect(isStorageCapacityError(undefined)).toBe(false);
    expect(isStorageCapacityError("nope")).toBe(false);
  });
});

describe("persistPermissionPreferenceSafely", () => {
  it("runs the write when it succeeds", () => {
    const fn = vi.fn();
    expect(() => persistPermissionPreferenceSafely("command permission", fn)).not.toThrow();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("swallows a storage-capacity throw (approval must proceed) and warns the user once", () => {
    expect(() =>
      persistPermissionPreferenceSafely("command permission", () => {
        throw cantopen();
      }),
    ).not.toThrow();
    expect(showAgentNotification).toHaveBeenCalledOnce();
  });

  it("debounces the storage-full notice across a burst of failures", () => {
    for (let i = 0; i < 5; i++) {
      persistPermissionPreferenceSafely("command permission", () => {
        throw cantopen();
      });
    }
    expect(showAgentNotification).toHaveBeenCalledOnce();
  });

  it("swallows a non-storage throw WITHOUT notifying the user", () => {
    expect(() =>
      persistPermissionPreferenceSafely("file permission", () => {
        throw new Error("some other db error");
      }),
    ).not.toThrow();
    expect(showAgentNotification).not.toHaveBeenCalled();
  });
});
