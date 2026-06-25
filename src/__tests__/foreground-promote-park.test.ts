/**
 * A5 — foreground → background promotion clears the waiting chip.
 *
 * A foreground run_command still running at the 15s auto-detach is moved to the
 * background registry; the interceptor re-emits a `terminal-output` running
 * event with background:true under the SAME operationId. The handler must clear
 * that command's foreground wait tracker so the amber "waiting on command" chip
 * flips off (command_done) and the turn parks instead of looking stuck.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { BrowserWindow } from "electron";
import {
  registerInterceptor,
  clearWaitTrackersForChat,
} from "@/ipc/handlers/permissions/handlers";

type Sent = { channel: string; payload: { phase?: string; commandId?: string } };

describe("foreground promote→park handoff (A5)", () => {
  let sent: Sent[];

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: Sent["payload"]) =>
            sent.push({ channel, payload }),
        },
      },
    ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
  });

  const phases = (s: Sent[]) =>
    s.filter((x) => x.channel === "chat:stream:phase").map((x) => x.payload.phase);

  it("clears the announced waiting chip when the command auto-promotes", () => {
    const chatId = 5500;
    const interceptor = new EventEmitter();
    registerInterceptor(chatId, interceptor as never);

    // Foreground command starts running.
    interceptor.emit("terminal-output", {
      operationId: "op-promote",
      command: "sleep 99",
      output: "",
      status: "running",
      background: false,
    });
    // 10s later → the waiting chip appears.
    vi.advanceTimersByTime(10_000);
    expect(phases(sent)).toContain("waiting_on_command");

    // 15s auto-detach: same operationId re-emitted as background:true.
    interceptor.emit("terminal-output", {
      operationId: "op-promote",
      command: "sleep 99",
      output: "partial output",
      status: "running",
      background: true,
    });
    // The chip flips off (so the turn can park).
    expect(phases(sent)).toContain("command_done");
    expect(
      sent.find((s) => s.payload.phase === "command_done")?.payload.commandId,
    ).toBe("op-promote");

    clearWaitTrackersForChat(chatId);
  });

  it("does not emit command_done when promotion happens before the chip showed", () => {
    const chatId = 5501;
    const interceptor = new EventEmitter();
    registerInterceptor(chatId, interceptor as never);

    interceptor.emit("terminal-output", {
      operationId: "op-fast",
      command: "x",
      output: "",
      status: "running",
      background: false,
    });
    // Promote immediately (before the 10s waiting chip fired).
    interceptor.emit("terminal-output", {
      operationId: "op-fast",
      command: "x",
      output: "",
      status: "running",
      background: true,
    });

    expect(phases(sent)).not.toContain("waiting_on_command");
    // Tracker existed but was never announced → nothing to flip off.
    expect(phases(sent)).not.toContain("command_done");

    clearWaitTrackersForChat(chatId);
  });
});
