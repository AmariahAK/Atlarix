/**
 * A stopped round still counts the tokens its finished steps spent: onEnd never
 * runs after a stop, so onAbort adds them (QA A22, the Usage page).
 */
import { describe, expect, it, vi } from "vitest";

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

const { addFinishedStepsUsage } = await import(
  "@/ipc/handlers/chat_stream/turn-runner/simple-stream-text"
);

describe("a stopped round's finished steps", () => {
  it("add their input, output and cache tokens to the turn", () => {
    const ctx = {
      turnInputTokens: 10,
      turnOutputTokens: 1,
      turnCachedInputTokens: 0,
      turnCacheCreationTokens: 0,
    };
    addFinishedStepsUsage(ctx, [
      {
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          inputTokenDetails: { cacheReadTokens: 600, cacheWriteTokens: 100 },
        },
      },
      { usage: { inputTokens: 1200, outputTokens: 30 } },
      // The step in flight at the stop: the provider sent no usage.
      { usage: undefined },
    ]);
    expect(ctx).toEqual({
      turnInputTokens: 2210,
      turnOutputTokens: 81,
      turnCachedInputTokens: 600,
      turnCacheCreationTokens: 100,
    });
  });

  it("is what onAbort runs", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(
        __dirname,
        "../ipc/handlers/chat_stream/turn-runner/simple-stream-text.ts",
      ),
      "utf8",
    );
    const abort = src.indexOf("onAbort: ({ steps }) => {");
    expect(abort).toBeGreaterThan(-1);
    expect(src.slice(abort, abort + 600)).toContain(
      "addFinishedStepsUsage(ctx, steps);",
    );
  });
});
