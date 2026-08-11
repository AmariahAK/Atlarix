/**
 * On-device Whisper transcription worker (transformers.js v4, ONNX Runtime Web).
 *
 * Runs entirely in the renderer via a Web Worker so inference never blocks the
 * UI. Prefers WebGPU and falls back to WASM. The ONNX Runtime itself ships inside
 * the app (see `wasmPaths` below); only the model weights are fetched, once, from
 * the HF CDN and cached (Cache Storage, persisted under userData) — genuinely
 * offline afterwards. No native build surface.
 *
 * Message protocol (main thread ⇄ worker):
 *   → { type: "load", model?, skipWebGpu? }        load/warm the pipeline
 *   → { type: "transcribe", id, audio: Float32Array, language? }
 *   ← { type: "ready", device }                    pipeline loaded
 *   ← { type: "progress", status, file?, progress?, loaded?, total? }
 *   ← { type: "diag", message }                    forwarded to the main log
 *   ← { type: "result", id, text }
 *   ← { type: "error", id?, message }              no `id` ⇒ the LOAD failed
 *
 * `audio` MUST be mono 16 kHz Float32 PCM (Whisper's expected input); the caller
 * (useVoiceInput) resamples via an OfflineAudioContext before posting.
 */

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import {
  WHISPER_MODEL,
  buildPipelineOptions,
  type WhisperDevice,
} from "./whisper-config";

/**
 * ONNX Runtime is served from INSIDE the app, not from a CDN.
 *
 * transformers.js defaults `wasmPaths` to
 * `https://cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/…` whenever it is unset
 * (backends/onnx.js). Leaving it unset meant every cold start fetched **23.5 MB of
 * runtime** from jsdelivr — a second network host nobody had accounted for, pinned to an
 * npm PRERELEASE version, as the very first thing that happens, with no progress
 * reporting and no timeout (the failure is swallowed by a `logger.warn`). A blocked or
 * black-holed jsdelivr therefore presented as a mic that span at 0% with no error, and
 * the "works offline afterwards" claim above was false. jsdelivr is also blocked outright
 * in some regions.
 *
 * Vite was already emitting the identical `.wasm` into the asar as dead weight. These two
 * `?url` imports (onnxruntime-web exports both as bare subpaths) make it the file we
 * actually load. `useWasmCache = false` skips transformers' own preload-and-cache layer
 * for the runtime, which exists to spare repeat CDN trips we no longer make — ORT then
 * loads straight from these local URLs. Both mechanisms (`fetch` of a `file://` wasm,
 * `import()` of a `file://` mjs) are verified to work from a worker in a packaged build.
 */
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";

// Remote models only (bundling weights would bloat the asar); cached after first
// fetch. allowLocalModels=false skips a pointless local-path probe per load.
env.allowLocalModels = false;
env.useWasmCache = false;
env.backends.onnx.wasm!.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };

/** Model actually loaded, so `transcribe` can't silently resolve a different one. */
let loadedModel: string = WHISPER_MODEL;

type LoadMessage = {
  type: "load";
  model?: string;
  /**
   * Skip the WebGPU attempt outright. Set by the main thread when a previous worker in
   * this session already proved WebGPU cannot build a session here — see `webGpuKnownBad`.
   */
  skipWebGpu?: boolean;
};
type TranscribeMessage = {
  type: "transcribe";
  id: string;
  audio: Float32Array;
  language?: string;
};
type InboundMessage = LoadMessage | TranscribeMessage;

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null =
  null;
let loadedDevice: WhisperDevice = "wasm";

/**
 * Set once WebGPU has failed in this worker, so a retry does not pay for it again.
 *
 * The pre-flight gate cannot predict a session failure: on hardware observed in testing,
 * `requestAdapter()` AND `requestDevice()` both succeed — the device is real — and ONNX
 * Runtime can still fail to build a session. Since both devices now use the same dtype
 * this is far cheaper than it was (a failed WebGPU attempt wastes no download, and the
 * fallback reuses the same cached weights), but it still costs a session build, so
 * remembering the verdict sends later attempts straight to WASM.
 *
 * Deliberately not persisted to disk: a driver or browser update can change the answer.
 * It IS carried across a worker rebuild within the session via `skipWebGpu`, because the
 * main thread replaces this worker on a load failure.
 */
let webGpuKnownBad = false;

/**
 * A load with no callback activity for this long is treated as stalled and fails loudly.
 *
 * Without it, a black-holed connection produces no progress, no error and no end — the
 * mic spins forever. That is the one shape the previous fix (ending the spinner on
 * `error`) does not cover, because a hang never produces an error.
 *
 * The window has to be generous: after the last file downloads, ONNX Runtime builds the
 * session, which emits no callbacks and can legitimately take a while. So this can only
 * mis-fire if session construction alone is silent for two minutes — and a mis-fire
 * yields a retryable error, which is strictly better than an unbounded spin.
 */
const LOAD_STALL_TIMEOUT_MS = 120_000;

function diag(message: string): void {
  self.postMessage({ type: "diag", message });
}

/**
 * Reject if `work` makes no progress for `LOAD_STALL_TIMEOUT_MS`. `touch()` is called
 * from the progress callback; the returned promise settles with `work` otherwise.
 *
 * The underlying work is not cancellable (there is no abort signal threaded through
 * transformers.js), so a stalled load is abandoned rather than aborted. Harmless: any
 * bytes it does eventually deliver land in Cache Storage and count towards the retry.
 */
function withStallWatchdog<T>(
  work: (touch: () => void) => Promise<T>,
): Promise<T> {
  let lastActivityAt = Date.now();
  const touch = () => {
    lastActivityAt = Date.now();
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setInterval(() => {
      if (Date.now() - lastActivityAt < LOAD_STALL_TIMEOUT_MS) return;
      reject(
        new Error(
          `The speech model stopped downloading (no progress for ${Math.round(
            LOAD_STALL_TIMEOUT_MS / 1000,
          )}s). Check your connection and try again, or switch to a cloud engine in Settings → AI → Voice input.`,
        ),
      );
    }, 5_000);
  });
  // `Promise.race` attaches a handler to both, so whichever loses cannot surface as an
  // unhandled rejection; clearing the timer stops the watchdog firing after a win.
  return Promise.race([work(touch), stalled]).finally(() => {
    if (timer) clearInterval(timer);
  });
}

/** Load the ASR pipeline, preferring WebGPU and falling back to WASM. */
async function getTranscriber(
  model: string,
): Promise<AutomaticSpeechRecognitionPipeline> {
  // Memoized so concurrent callers share one load. But a REJECTED promise must not
  // be memoized: it used to be, so a single failed load poisoned the worker for its
  // whole lifetime — every later `load`/`transcribe` re-returned the same rejection
  // and the only recovery was restarting the app. Clearing it on failure makes a
  // retry (e.g. after a network blip, or once the model cache is cleared) actually
  // retry.
  if (transcriberPromise) return transcriberPromise;

  transcriberPromise = withStallWatchdog(async (touch) => {
    const progress_callback = (p: unknown) => {
      const info = p as {
        status?: string;
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
      };
      touch();
      self.postMessage({
        type: "progress",
        status: info.status ?? "loading",
        file: info.file,
        progress: info.progress,
        // Forwarded so the main thread can aggregate across files rather than showing
        // whichever file reported last, which made the bar jump around.
        loaded: info.loaded,
        total: info.total,
      });
    };

    // WebGPU first; fall back to WASM on machines without it or where the GPU cannot
    // build a session.
    //
    // Require a real, USABLE WebGPU device — not merely the API, and not merely an
    // adapter. This gate has been wrong twice, each time costing the user something:
    //
    //  1. `typeof navigator.gpu !== "undefined"` — Chromium exposes the API on
    //     machines whose GPU cannot back it, so we entered the WebGPU path anyway
    //     and `onnxruntime-web` logged its own console.error ("no available backend
    //     found … Failed to get GPU adapter") before the catch below could fall back.
    //  2. `requestAdapter()` alone — an adapter can be returned and still be a
    //     software fallback that cannot execute the model's operators.
    //
    // Requesting a DEVICE is the strongest signal available, and it is still not
    // sufficient: whether ORT can BUILD A SESSION is only knowable by trying. So the
    // gate is no longer asked to predict that — the fallback below is now genuinely
    // able to run (see `whisper-config.ts`) and is genuinely reachable (see the
    // transformers.js patch), which is what makes an unpredictable failure survivable.
    const hasWebGpu = webGpuKnownBad
      ? false
      : await (async () => {
          const gpu = (
            navigator as unknown as {
              gpu?: {
                requestAdapter?: () => Promise<{
                  requestDevice?: () => Promise<{
                    destroy?: () => void;
                  } | null>;
                } | null>;
              };
            }
          ).gpu;
          if (!gpu?.requestAdapter) return false;
          try {
            const adapter = await gpu.requestAdapter();
            if (!adapter?.requestDevice) return false;
            const device = await adapter.requestDevice();
            if (!device) return false;
            // Release it immediately; transformers.js acquires its own.
            device.destroy?.();
            return true;
          } catch {
            return false;
          }
        })();

    if (hasWebGpu) {
      const options = buildPipelineOptions("webgpu");
      diag(`loading ${model} on webgpu (dtype=${options.dtype})`);
      try {
        const t = await pipeline("automatic-speech-recognition", model, {
          ...options,
          progress_callback,
        });
        loadedDevice = "webgpu";
        return t as AutomaticSpeechRecognitionPipeline;
      } catch (e) {
        // Do not pay for this attempt again in this worker — see `webGpuKnownBad`.
        webGpuKnownBad = true;
        const reason =
          e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
        // Include the reason. Previously this said only
        // "webgpu-unavailable-falling-back-to-wasm" while ONNX Runtime's own
        // console.error was the only thing carrying the cause — so the user saw a
        // raw session error and no explanation that we had recovered from it.
        diag(`webgpu load failed, falling back to wasm: ${reason}`);
        self.postMessage({
          type: "progress",
          status: "webgpu-unavailable-falling-back-to-wasm",
          message: reason,
        });
      }
    } else {
      diag(
        webGpuKnownBad
          ? "skipping webgpu (already failed in this session)"
          : "no usable webgpu device",
      );
    }

    // Same weights as the WebGPU attempt, so a fallback re-downloads nothing — and the
    // dtype is the one measured to actually build a session on the CPU provider, which
    // is the whole bug. See whisper-config.ts.
    const options = buildPipelineOptions("wasm");
    diag(`loading ${model} on wasm (dtype=${options.dtype})`);
    const t = await pipeline("automatic-speech-recognition", model, {
      ...options,
      progress_callback,
    });
    loadedDevice = "wasm";
    return t as AutomaticSpeechRecognitionPipeline;
  });

  // Un-memoize a failure so the next attempt is a real attempt. The rejection is
  // still propagated to this caller (and surfaced by the onmessage catch); this only
  // stops it being cached as the permanent answer.
  transcriberPromise.catch(() => {
    transcriberPromise = null;
  });

  return transcriberPromise;
}

self.onmessage = async (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  try {
    if (msg.type === "load") {
      loadedModel = msg.model ?? WHISPER_MODEL;
      if (msg.skipWebGpu) webGpuKnownBad = true;
      await getTranscriber(loadedModel);
      diag(`model ready on device=${loadedDevice}`);
      self.postMessage({ type: "ready", device: loadedDevice });
      return;
    }
    if (msg.type === "transcribe") {
      // `loadedModel`, not WHISPER_MODEL: a transcribe arriving before any load
      // must not pin a different model than the one `load` asked for. Harmless
      // today only because the pipeline promise is memoized.
      const transcriber = await getTranscriber(loadedModel);
      const seconds = msg.audio.length / 16000;
      // Whisper handles ≤30s in a single pass. Only enable the long-form
      // chunk+stride algorithm for genuinely long clips — running it on a short
      // dictation feeds the stride overlap silence/padding, which Whisper
      // hallucinates as a repeated phrase ("I'm I'm I'm…"). no_repeat_ngram_size
      // additionally breaks any residual degenerate repetition loop.
      const options: Record<string, unknown> = {
        // Explicit language skips Whisper's per-clip language DETECTION, which is
        // unreliable on short dictation and silently mis-transcribes when it
        // guesses wrong. Caller resolves it (navigator.language / setting);
        // undefined still falls back to auto-detect rather than forcing English.
        language: msg.language,
        return_timestamps: false,
        no_repeat_ngram_size: 3,
        temperature: 0,
        // Beam search over greedy. Greedy (num_beams=1) is the fastest and least
        // accurate setting; 4 beams is the standard accuracy/latency trade and
        // the cost is hidden inside dictation's existing transcribe pause.
        num_beams: 4,
      };
      if (seconds > 30) {
        options.chunk_length_s = 30;
        options.stride_length_s = 5;
      }
      const output = await transcriber(msg.audio, options);
      const text = Array.isArray(output)
        ? output.map((o) => o.text).join(" ")
        : (output.text ?? "");
      self.postMessage({
        type: "result",
        id: msg.id,
        text: text.trim(),
        seconds,
      });
      return;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    diag(`${msg.type} failed: ${message.slice(0, 300)}`);
    self.postMessage({
      // No `id` means the LOAD failed, which the main thread treats as a reason to
      // rebuild this worker — see useVoiceInput.
      type: "error",
      id: msg.type === "transcribe" ? msg.id : undefined,
      message,
    });
  }
};
