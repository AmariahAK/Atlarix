/**
 * Bug 9 regression: stdinStream() must not throw "Controller is already closed"
 * when stdin emits 'data' or 'end' after the ReadableStream has already been
 * closed (Bun 1.4.2 / Windows / VS Code surface: client disconnects mid-stream).
 *
 * We can't import server.ts directly (it imports electron-log and ACP internals),
 * so we replicate the exact guard pattern and verify it holds.
 */
import { describe, it, expect } from "vitest";

/**
 * A minimal reproduction of the stdinStream() guard pattern from
 * src/cli/acp/server.ts — the same logic, isolated for testing.
 */
function makeGuardedStream(
  emitter: { on: (event: string, cb: (...args: unknown[]) => void) => void },
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const onData = (chunk: Buffer) => {
        if (!closed) controller.enqueue(new Uint8Array(chunk));
      };
      const onEnd = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      const onError = (e: Error) => {
        if (!closed) {
          closed = true;
          controller.error(e);
        }
      };
      emitter.on("data", onData as (...args: unknown[]) => void);
      emitter.on("end", onEnd as (...args: unknown[]) => void);
      emitter.on("error", onError as (...args: unknown[]) => void);
    },
  });
}

describe("stdinStream closed-state guard (Bug 9)", () => {
  it("does not throw when 'end' fires twice (double-close)", async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const emitter = {
      on(event: string, cb: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
      },
      emit(event: string, ...args: unknown[]) {
        for (const cb of listeners[event] ?? []) cb(...args);
      },
    };

    const stream = makeGuardedStream(emitter);
    const reader = stream.getReader();

    // First 'end' closes the stream normally.
    emitter.emit("end");

    // Second 'end' must NOT throw — the guard swallows it.
    expect(() => emitter.emit("end")).not.toThrow();

    // The reader should see the stream as done.
    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  it("does not throw when 'data' fires after 'end' (Bun disconnect race)", async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const emitter = {
      on(event: string, cb: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
      },
      emit(event: string, ...args: unknown[]) {
        for (const cb of listeners[event] ?? []) cb(...args);
      },
    };

    const stream = makeGuardedStream(emitter);
    const reader = stream.getReader();

    // Close the stream via 'end'.
    emitter.emit("end");

    // A late 'data' chunk after close must NOT throw.
    expect(() => emitter.emit("data", Buffer.from("late"))).not.toThrow();

    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  it("delivers data chunks before close", async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const emitter = {
      on(event: string, cb: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
      },
      emit(event: string, ...args: unknown[]) {
        for (const cb of listeners[event] ?? []) cb(...args);
      },
    };

    const stream = makeGuardedStream(emitter);
    const reader = stream.getReader();

    emitter.emit("data", Buffer.from("hello"));
    emitter.emit("data", Buffer.from(" world"));
    emitter.emit("end");

    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString();
    expect(text).toBe("hello world");
  });
});
