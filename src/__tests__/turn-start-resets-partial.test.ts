import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * QA 15.7.1 #2: stop a turn before its first token and the PREVIOUS turn's
 * reply was saved as the stopped one. A normal end leaves the reply in
 * `partialResponses`, and the stop path reads it. Each turn now starts empty.
 */

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const S = await import("@/ipc/handlers/chat_stream/stream-state");

describe("a new turn inherits nothing from the last one", () => {
  it("clears the last turn's reply and a pending ask_user", () => {
    S.partialResponses.set(7, "It defines a function add…");
    S.pendingAskUserArtifactByChatId.set(7, {} as never);
    S.partialResponses.set(8, "another chat");
    S.resetTurnState(7);
    expect(S.partialResponses.has(7)).toBe(false);
    expect(S.pendingAskUserArtifactByChatId.has(7)).toBe(false);
    // Only that chat.
    expect(S.partialResponses.get(8)).toBe("another chat");
  });

  it("runs when a stream starts, before anything can stream or stop", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../ipc/handlers/chat_stream_handlers.ts"),
      "utf8",
    );
    const start = src.indexOf(
      "activeStreams.set(req.chatId, abortController);",
    );
    const reset = src.indexOf("resetTurnState(req.chatId);");
    expect(start).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(start);
    // Right after the stream is registered: nothing in between awaits.
    expect(src.slice(start, reset)).not.toContain("await ");
  });
});
