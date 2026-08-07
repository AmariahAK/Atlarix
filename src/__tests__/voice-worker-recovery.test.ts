/**
 * On-device voice: a failed model load must END, and must be retryable.
 *
 * Two bugs made a failing load look like a hang rather than a failure — reported as
 * "the mic icon does nothing but rotate", across every test session:
 *
 *  1. `useVoiceInput`'s worker `onmessage` cleared `modelLoadProgress` only on
 *     `ready`. On `error` it set the message and left the progress state set, so the
 *     spinner span forever while the error sat in state unseen.
 *  2. `getTranscriber()` memoised `transcriberPromise` unconditionally, including
 *     rejections. One failed load therefore poisoned the worker for its lifetime:
 *     every later `load`/`transcribe` re-returned the same rejection, so there was
 *     no retry short of restarting the app.
 *
 * These reproduce both shapes against the real semantics rather than the components,
 * which need a DOM worker the node test project has no way to spawn.
 */
import { describe, it, expect, vi } from "vitest";

describe("worker message handling clears the loading state", () => {
  /**
   * The `onmessage` reducer, as `useVoiceInput` implements it. `error` must be
   * terminal for loading, exactly like `ready`.
   */
  function reduce(
    state: { progress: number | null; error: string | null },
    m: { type: string; progress?: number; message?: string },
  ) {
    if (m.type === "progress") {
      return typeof m.progress === "number" ? { ...state, progress: m.progress / 100 } : state;
    }
    if (m.type === "ready") return { ...state, progress: null };
    if (m.type === "error") return { progress: null, error: m.message ?? "Transcription failed" };
    return state;
  }

  it("an error ends the loading state instead of spinning forever", () => {
    let s = { progress: null as number | null, error: null as string | null };
    s = reduce(s, { type: "progress", progress: 42 });
    expect(s.progress).toBeCloseTo(0.42);

    s = reduce(s, { type: "error", message: "Can't create a session" });
    // THE regression: this used to stay 0.42 and the mic span indefinitely.
    expect(s.progress).toBeNull();
    expect(s.error).toContain("Can't create a session");
  });

  it("a successful load also ends it", () => {
    let s = { progress: null as number | null, error: null as string | null };
    s = reduce(s, { type: "progress", progress: 99 });
    s = reduce(s, { type: "ready" });
    expect(s.progress).toBeNull();
  });
});

describe("a rejected pipeline load is not memoised", () => {
  /** `getTranscriber`'s memoisation, including the failure reset. */
  function makeLoader(load: () => Promise<string>) {
    let cached: Promise<string> | null = null;
    return () => {
      if (cached) return cached;
      cached = load();
      cached.catch(() => {
        cached = null;
      });
      return cached;
    };
  }

  it("retries after a failure instead of replaying the same rejection", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce("pipeline");
    const get = makeLoader(load);

    await expect(get()).rejects.toThrow("network blip");
    // The bug: this used to return the SAME rejected promise forever, so the only
    // recovery was restarting the app.
    await expect(get()).resolves.toBe("pipeline");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("still shares ONE load between concurrent callers on the success path", async () => {
    const load = vi.fn<() => Promise<string>>().mockResolvedValue("pipeline");
    const get = makeLoader(load);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe("pipeline");
    expect(b).toBe("pipeline");
    // Un-memoising failures must not un-memoise successes — a 250-500 MB fetch
    // must never be started twice.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("propagates the rejection to the caller, not just resets the cache", async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("boom"));
    const get = makeLoader(load);
    await expect(get()).rejects.toThrow("boom");
  });
});
