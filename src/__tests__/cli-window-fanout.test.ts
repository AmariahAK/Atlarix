/**
 * The CLI's stand-in window (src/headless/electron-stub.ts) fans broadcasts out
 * to every attached session. `atlarix acp` runs one session per editor thread;
 * with a single slot the newest took every `permission-request`, and the other
 * threads' approvals never reached their editor.
 */
import { describe, expect, it } from "vitest";
import { attachCliWindow, BrowserWindow } from "@/headless/electron-stub";

type Win = { webContents: { send: (c: string, p: unknown) => void } };

describe("attachCliWindow", () => {
  it("every attached session hears a broadcast, until it detaches", () => {
    const a: string[] = [];
    const b: string[] = [];
    const detachA = attachCliWindow((c) => a.push(c));
    const detachB = attachCliWindow((c) => b.push(c));
    const wins = BrowserWindow.getAllWindows() as Win[];
    expect(wins).toHaveLength(1);
    wins[0]!.webContents.send("permission-request", {});
    expect(a).toEqual(["permission-request"]);
    expect(b).toEqual(["permission-request"]);

    detachA();
    (BrowserWindow.getAllWindows() as Win[])[0]!.webContents.send("chat:interjections", {});
    expect(a).toEqual(["permission-request"]);
    expect(b).toEqual(["permission-request", "chat:interjections"]);

    detachB();
    expect(BrowserWindow.getAllWindows()).toHaveLength(0);
  });
});
