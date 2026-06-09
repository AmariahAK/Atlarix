/**
 * v12.10: broadcastToAllWindows must guard at the webContents level, not just
 * the window. During teardown a window can report !isDestroyed() while its
 * webContents is already gone, so `win.webContents.send(...)` throws
 * "Object has been destroyed" (a fatal main-process Sentry crash).
 */

import { describe, it, expect, vi } from "vitest";

const fakeWindows: unknown[] = [];
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => fakeWindows },
}));
vi.mock("electron-log", () => ({ default: { debug: () => {} } }));

import { broadcastToAllWindows } from "@/ipc/utils/broadcast_all_windows";

describe("broadcastToAllWindows", () => {
  it("delivers to healthy windows and skips torn-down ones without throwing", () => {
    const sent: string[] = [];
    fakeWindows.length = 0;
    fakeWindows.push(
      // healthy
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isCrashed: () => false,
          send: (c: string) => sent.push(c),
        },
      },
      // webContents already destroyed
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => true,
          isCrashed: () => false,
          send: () => {
            throw new Error("Object has been destroyed");
          },
        },
      },
      // window destroyed — webContents getter itself throws
      {
        isDestroyed: () => true,
        get webContents(): never {
          throw new Error("Object has been destroyed");
        },
      },
      // race: isDestroyed false but send still throws
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isCrashed: () => false,
          send: () => {
            throw new Error("Object has been destroyed");
          },
        },
      },
    );

    expect(() =>
      broadcastToAllWindows("apps:status-changed", { ok: true }),
    ).not.toThrow();
    // Only the healthy window received the message.
    expect(sent).toEqual(["apps:status-changed"]);
  });
});
