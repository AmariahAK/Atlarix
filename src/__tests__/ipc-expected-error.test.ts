/**
 * ATLARIX-45: an IPC handler reported every error to Sentry, including a Recent
 * folder the user had moved. An expected user condition is logged, not reported,
 * and reaches the renderer as its plain message; anything else is reported as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, captureException } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  captureException: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(ch, fn),
  },
}));
vi.mock("@sentry/electron/main", () => ({ captureException }));

import { createLoggedHandler } from "@/ipc/handlers/safe_handle";
import { ExpectedUserError, expectedErrorOf } from "@/shared/expected_error";

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const event = { senderFrame: { url: "file:///index.html" } };

describe("createLoggedHandler", () => {
  beforeEach(() => {
    handlers.clear();
    captureException.mockClear();
  });

  it("does not report an expected user error, and passes its kind and plain message on", async () => {
    createLoggedHandler(logger)("import-app", async () => {
      throw new ExpectedUserError("This folder no longer exists.", "folder-missing");
    });
    const err = await handlers.get("import-app")!(event).catch((e: Error) => e);
    expect(captureException).not.toHaveBeenCalled();
    // What the renderer sees, after Electron prefixes its own text.
    const crossed = new Error(`Error invoking remote method 'import-app': Error: ${(err as Error).message}`);
    expect(expectedErrorOf(crossed)).toEqual({
      kind: "folder-missing",
      message: "This folder no longer exists.",
    });
  });

  it("still reports any other error", async () => {
    createLoggedHandler(logger)("import-app", async () => {
      throw new Error("disk on fire");
    });
    const err = await handlers.get("import-app")!(event).catch((e: Error) => e);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(expectedErrorOf(err)).toBeNull();
  });
});
