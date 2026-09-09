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
 *  3. THE root cause: the WASM fallback could never build a session at all, on any
 *     platform, because ORT's default graph optimizations crash on Whisper's merged
 *     INT8 decoder. Fixed by using q4 for both devices — see `whisper-config.ts`.
 *  4. And what made it unrecoverable: transformers.js serialises ONNX session creation
 *     through a module-level promise chain it left REJECTED after any failure, so the
 *     fallback never even ran. Patched in
 *     `patches/@huggingface+transformers+4.2.0.patch`; the semantics are pinned below
 *     so the intent survives losing the patch.
 *
 * These reproduce the shapes against the real semantics rather than the components,
 * which need a DOM worker the node test project has no way to spawn. What CAN be
 * imported directly is imported directly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  WASM_FORBIDDEN_DTYPES,
  WHISPER_DTYPE,
  buildPipelineOptions,
} from "@/lib/voice/whisper-config";
import { aggregateProgress } from "@/hooks/useVoiceInput";

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
      return typeof m.progress === "number"
        ? { ...state, progress: m.progress / 100 }
        : state;
    }
    if (m.type === "ready") return { ...state, progress: null };
    if (m.type === "error")
      return { progress: null, error: m.message ?? "Transcription failed" };
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
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("boom"));
    const get = makeLoader(load);
    await expect(get()).rejects.toThrow("boom");
  });
});

/**
 * Why the WebGPU→WASM fallback could not be trusted to run at all.
 *
 * transformers.js serialises session creation through one module-level promise
 * (`backends/onnx.js`), because ORT cannot build two sessions at once:
 *
 *   webInitChain = webInitChain.then(load)
 *
 * There is no `.catch`. Once that promise rejects it stays rejected, and every later
 * `.then(load)` re-rejects with the ORIGINAL error without ever calling `load`. So the
 * FIRST session failure of the worker's life — whatever caused it — permanently disabled
 * every session build after it, including the fallback whose entire job is to recover, and
 * including every retry.
 *
 * Verified end-to-end against the real library, not just modelled here: forcing a genuine
 * session-creation failure (corrupt ONNX bytes) and then loading a real model reproduced
 * the replay, and the patch makes the second load actually run.
 *
 * This is NOT what produced the Windows error message — that was the WASM path's own int8
 * failure, see `whisper-config.ts`. It is why that failure was unrecoverable rather than
 * merely a fallback away from working.
 */
describe("session creation is not poisoned by an earlier failure", () => {
  type Create = (load: () => Promise<string>) => Promise<string>;

  /** Exactly what transformers.js shipped. */
  function unpatchedChain(): Create {
    let chain: Promise<unknown> = Promise.resolve();
    return (load) => {
      chain = chain.then(load);
      return chain as Promise<string>;
    };
  }

  /** What the patch makes it. `then(load, load)` runs on the rejected branch too. */
  function patchedChain(): Create {
    let chain: Promise<unknown> = Promise.resolve();
    return (load) => {
      const attempt = chain.then(load, load);
      // The chain ITSELF is kept resolved, so a rejection is never replayed while
      // calls stay serialised behind it.
      chain = attempt.catch(() => {});
      return attempt as Promise<string>;
    };
  }

  const sessionFailure = () =>
    new Error(
      "Can't create a session. ERROR_CODE: 1, ERROR_MESSAGE: qdq_actions.cc:137 " +
        "TransposeDQWeightsForMatMulNBits Missing required scale",
    );

  it("REGRESSION: unpatched, the fallback is never even attempted", async () => {
    const create = unpatchedChain();
    const first = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(sessionFailure());
    const fallback = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("session");

    await expect(create(first)).rejects.toThrow("MatMulNBits");
    // THE BUG: the fallback's own loader is never called, and the caller is handed the
    // FIRST attempt's error — so the reported message describes a model that was never
    // loaded, which is exactly how this misled two rounds of diagnosis.
    await expect(create(fallback)).rejects.toThrow("MatMulNBits");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("patched, the fallback runs and succeeds", async () => {
    const create = patchedChain();
    const first = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(sessionFailure());
    const fallback = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("session");

    await expect(create(first)).rejects.toThrow("MatMulNBits");
    await expect(create(fallback)).resolves.toBe("session");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("patched, a failure does not poison the calls after it either", async () => {
    const create = patchedChain();
    const bad = () => Promise.reject(new Error("transient"));
    const good = () => Promise.resolve("session");

    await expect(create(bad)).rejects.toThrow("transient");
    await expect(create(good)).resolves.toBe("session");
    await expect(create(bad)).rejects.toThrow("transient");
    await expect(create(good)).resolves.toBe("session");
  });

  it("patched, creations are still serialised — never two at once", async () => {
    const create = patchedChain();
    let inFlight = 0;
    let maxInFlight = 0;
    const load = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return "session";
    };

    await Promise.all([create(load), create(load), create(load)]);
    // Serialisation is the whole reason the chain exists — ONNX cannot build two
    // sessions concurrently ("Session already started"). Un-poisoning it must not
    // un-serialise it.
    expect(maxInFlight).toBe(1);
  });

  it("patched, serialisation survives a rejection in the middle", async () => {
    const create = patchedChain();
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async (fail: boolean) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (fail) throw new Error("boom");
      return "session";
    };

    const results = await Promise.allSettled([
      create(() => track(false)),
      create(() => track(true)),
      create(() => track(false)),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("the inference chain has the same shape, for the same reason", async () => {
    // `webInferenceChain` is the identical pattern one function down: one failed
    // inference would otherwise replay its rejection for every later transcription.
    const run = patchedChain();
    await expect(
      run(() => Promise.reject(new Error("gpu hiccup"))),
    ).rejects.toThrow("gpu hiccup");
    await expect(run(() => Promise.resolve("transcript"))).resolves.toBe(
      "transcript",
    );
  });
});

describe("the transformers.js patch is actually applied", () => {
  /**
   * Guards the patch itself, not a model of it.
   *
   * `postinstall` used to read `patch-package && node …/electron/install.js || true`,
   * where the `|| true` swallowed a FAILED patch application as well as the Electron
   * install it was written for. That is now scoped to the Electron install, but the
   * consequence of losing this patch is severe and silent — on-device voice goes back to
   * being permanently dead on any machine whose first session build fails — so assert the
   * shipped file directly. If a dependency bump changes it, this fails loudly here.
   */
  it("un-poisons both promise chains in the file the renderer bundles", () => {
    // Located relative to this file, not via `require.resolve`: the package's `exports`
    // map does not expose `./dist/*`, so node refuses to resolve the subpath even though
    // it is the file the renderer bundles (the map's `default` condition points at it).
    const entry = fileURLToPath(
      new URL(
        "../../node_modules/@huggingface/transformers/dist/transformers.web.js",
        import.meta.url,
      ),
    );
    const source = readFileSync(entry, "utf8");

    // The patched form runs `load` on the rejected branch too, and keeps the chain
    // itself resolved.
    expect(source).toContain("webInitChain.then(load, load)");
    expect(source).toContain("webInferenceChain.then(run, run)");
    // And the original, replay-forever form must be gone. Matched with its surrounding
    // ternary so this tests the executable code and not the patch's own comment, which
    // quotes the old line verbatim.
    expect(source).not.toContain("? webInitChain = webInitChain.then(load) :");
    expect(source).not.toContain(
      "? webInferenceChain = webInferenceChain.then(run) :",
    );
  });
});

/**
 * THE root cause, and the narrowest possible guard on it.
 *
 * ORT's `extended` graph-optimization level (inside its default `all`) runs
 * `TransposeDQWeightsForMatMulNBits`, which is broken for Whisper's MERGED decoder in the
 * pinned onnxruntime-web. Every int8 variant on the WASM execution provider therefore
 * failed at session creation — measured on macOS, so this was never a Windows GPU problem
 * and never about the q4 decoder it was blamed on:
 *
 *   q8/uint8 on wasm @ default → FAILS   ← what shipped, and what users saw
 *   q4       on wasm @ default → works   ← q4 IS MatMulNBits; nothing to transpose
 *   q4       on webgpu         → works, and 8x faster than q8 there
 *
 * The WASM fallback had consequently never worked on ANY platform. It only looked
 * Mac-only-good because macOS has WebGPU and never reached the fallback.
 */
describe("the WASM device never gets an int8 dtype", () => {
  it("does not use a dtype that cannot build a session on wasm", () => {
    const dtype = buildPipelineOptions("wasm").dtype;
    expect(WASM_FORBIDDEN_DTYPES).not.toContain(dtype);
  });

  it("names the hazard explicitly, so this fails if someone reaches for q8 again", () => {
    // Not a restatement of the current value: these three are the families whose
    // dequantized weights trigger the crashing pass.
    expect(WASM_FORBIDDEN_DTYPES).toEqual(["q8", "int8", "uint8"]);
  });

  it("uses q4, the variant measured to work on both devices", () => {
    expect(WHISPER_DTYPE).toBe("q4");
    expect(buildPipelineOptions("webgpu").dtype).toBe("q4");
    expect(buildPipelineOptions("wasm").dtype).toBe("q4");
  });

  it("the two devices agree, so a WebGPU failure re-downloads nothing", () => {
    // The old config asked for a 336.5 MB fp32 encoder + q4 decoder on WebGPU and int8 on
    // WASM, so failing over fetched a SECOND set of weights: 559 MB, then 238 MB more.
    expect(buildPipelineOptions("webgpu").dtype).toBe(
      buildPipelineOptions("wasm").dtype,
    );
  });

  it("does not carry a graphOptimizationLevel workaround", () => {
    // Capping WASM at `basic` also dodges the crashing pass, but q4 removes the reason to
    // dodge it. If this ever comes back, the dtype choice above has regressed.
    expect(
      (buildPipelineOptions("wasm") as { session_options?: unknown })
        .session_options,
    ).toBeUndefined();
  });
});

describe("download progress is aggregated across files", () => {
  const files = (entries: Array<[string, number, number]>) =>
    new Map(entries.map(([f, loaded, total]) => [f, { loaded, total }]));

  it("sums bytes rather than reporting whichever file reported last", () => {
    const agg = aggregateProgress(
      files([
        ["encoder_model_quantized.onnx", 44_000_000, 88_000_000],
        ["decoder_model_merged_quantized.onnx", 0, 149_500_000],
      ]),
    );
    expect(agg.loaded).toBe(44_000_000);
    expect(agg.total).toBe(237_500_000);
    expect(agg.progress).toBeCloseTo(44_000_000 / 237_500_000, 5);
  });

  it("does not snap backwards when a new file raises the denominator", () => {
    // The encoder alone is 90% done...
    const first = aggregateProgress(files([["encoder", 80, 88]]));
    // ...then the decoder appears and the honest fraction collapses to 43%.
    const second = aggregateProgress(
      files([
        ["encoder", 80, 88],
        ["decoder", 0, 100],
      ]),
    );
    expect(second.progress).toBeLessThan(first.progress);
    // Which is why the caller clamps to the running max — a bar that goes backwards
    // reads as "it restarted", the exact confusion this change exists to remove.
    const shown = Math.max(first.progress, second.progress);
    expect(shown).toBeCloseTo(first.progress, 5);
  });

  it("is 0 rather than NaN before any total is known", () => {
    expect(aggregateProgress(new Map()).progress).toBe(0);
  });
});

describe("a load that stops progressing fails instead of hanging forever", () => {
  /**
   * The worker's stall watchdog (`withStallWatchdog`). A black-holed connection —
   * a corporate proxy that neither answers nor refuses — produces no progress, no
   * error and no end, which is the one shape "clear the spinner on error" cannot fix.
   */
  function watchdog(timeoutMs: number, work: Promise<string>) {
    let lastActivityAt = Date.now();
    const touch = () => {
      lastActivityAt = Date.now();
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
      timer = setInterval(() => {
        if (Date.now() - lastActivityAt < timeoutMs) return;
        reject(new Error("The speech model stopped downloading"));
      }, 1_000);
    });
    const promise = Promise.race([work, stalled]).finally(() => {
      if (timer) clearInterval(timer);
    });
    return { promise, touch };
  }

  it("fires when nothing progresses", async () => {
    vi.useFakeTimers();
    try {
      const { promise } = watchdog(10_000, new Promise<string>(() => {}));
      const assertion = expect(promise).rejects.toThrow("stopped downloading");
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire while the download is still progressing", async () => {
    vi.useFakeTimers();
    try {
      let settle: (v: string) => void = () => {};
      const work = new Promise<string>((resolve) => {
        settle = resolve;
      });
      const { promise, touch } = watchdog(10_000, work);

      // Progress every 6s for a minute — well past the timeout in total elapsed time,
      // but never 10s of silence. A slow connection must not be cut off.
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(6_000);
        touch();
      }
      settle("pipeline");
      await expect(promise).resolves.toBe("pipeline");
    } finally {
      vi.useRealTimers();
    }
  });
});
