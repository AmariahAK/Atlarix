/**
 * On-device Whisper transcription worker (transformers.js v4, ONNX Runtime Web).
 *
 * Runs entirely in the renderer via a Web Worker so inference never blocks the
 * UI. Prefers WebGPU (real-time on whisper-base) and falls back to WASM. The
 * model + wasm are fetched once from the HF CDN and cached (Cache Storage,
 * persisted under userData) — fully offline afterwards. No native build surface.
 *
 * Message protocol (main thread ⇄ worker):
 *   → { type: "load", model? }                    load/warm the pipeline
 *   → { type: "transcribe", id, audio: Float32Array, language? }
 *   ← { type: "ready", device }                   pipeline loaded
 *   ← { type: "progress", status, file?, progress? }
 *   ← { type: "result", id, text }
 *   ← { type: "error", id?, message }
 *
 * `audio` MUST be mono 16 kHz Float32 PCM (Whisper's expected input); the caller
 * (useVoiceInput) resamples via an OfflineAudioContext before posting.
 */

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

// Remote models only (bundling weights would bloat the asar); cached after first
// fetch. allowLocalModels=false skips a pointless local-path probe per load.
env.allowLocalModels = false;

/**
 * `whisper-small` (244M) rather than `base` (74M). Base transcribes roughly the
 * right words and gets technical vocabulary wrong often enough to need editing,
 * which defeats the point of dictating. Small is a large accuracy step for a
 * one-time ~409 MB fetch (vs ~206 MB) that is cached permanently and works
 * offline afterwards.
 */
const DEFAULT_MODEL = "onnx-community/whisper-small";

/** Model actually loaded, so `transcribe` can't silently resolve a different one. */
let loadedModel: string = DEFAULT_MODEL;

type LoadMessage = { type: "load"; model?: string };
type TranscribeMessage = {
  type: "transcribe";
  id: string;
  audio: Float32Array;
  language?: string;
};
type InboundMessage = LoadMessage | TranscribeMessage;

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null =
  null;
let loadedDevice: "webgpu" | "wasm" = "wasm";

/**
 * Set once WebGPU has failed in this worker, so a retry does not pay for it again.
 *
 * The pre-flight gate cannot predict this failure. On hardware observed in testing,
 * `requestAdapter()` AND `requestDevice()` both succeed — the device is real — and
 * ONNX Runtime still cannot build a session for the q4 decoder, because it cannot
 * execute `MatMulNBits` (the 4-bit op q4 is made of). The only way to find out is to
 * try, by which point the fp32 encoder + q4 decoder (~500 MB) have been fetched.
 *
 * Since failures are no longer memoised, a retry would otherwise re-attempt WebGPU
 * and re-fetch all of it. Remembering the verdict sends every later attempt straight
 * to WASM. Deliberately per-worker rather than persisted: a driver or browser update
 * can change the answer, so a fresh session is allowed to try once more.
 */
let webGpuKnownBad = false;

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

  const progress_callback = (p: unknown) => {
    const info = p as { status?: string; file?: string; progress?: number };
    self.postMessage({
      type: "progress",
      status: info.status ?? "loading",
      file: info.file,
      progress: info.progress,
    });
  };

  transcriberPromise = (async () => {
    // WebGPU first (fp16 is the fast path); fall back to a quantized WASM build
    // on machines without WebGPU or where the GPU init throws.
    //
    // Require a real, USABLE WebGPU device — not merely the API, and not merely an
    // adapter. This gate has been wrong twice, each time costing the user something:
    //
    //  1. `typeof navigator.gpu !== "undefined"` — Chromium exposes the API on
    //     machines whose GPU cannot back it, so we entered the WebGPU path anyway
    //     and `onnxruntime-web` logged its own console.error ("no available backend
    //     found … Failed to get GPU adapter") before the catch below could fall back.
    //  2. `requestAdapter()` alone — an adapter can be returned and still be a
    //     software fallback that cannot execute `MatMulNBits`, the 4-bit op the q4
    //     decoder is built from. ONNX Runtime then fails at SESSION CREATION with
    //     "Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale",
    //     which reads like a corrupt download but is an unsupported-op problem.
    //
    // That second failure was expensive, not just noisy: by the time it fired we had
    // already fetched the fp32 encoder + q4 decoder (~500 MB), and the WASM fallback
    // then fetched q8 of both — 821 MB of Cache Storage on a machine that was always
    // going to run on CPU. Requesting a DEVICE is what proves the ops can run, so a
    // machine like that now downloads ONE variant.
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
      try {
        const t = await pipeline("automatic-speech-recognition", model, {
          device: "webgpu",
          // Per-component dtype (matches Xenova's realtime-whisper-webgpu): the
          // Whisper DECODER is broken in fp16 on WebGPU — a blanket fp16 produces
          // degenerate output ("I'm not." for real speech). Keep the encoder in
          // fp32 and quantize the decoder to q4.
          dtype: {
            encoder_model: "fp32",
            decoder_model_merged: "q4",
          },
          progress_callback,
        });
        loadedDevice = "webgpu";
        return t as AutomaticSpeechRecognitionPipeline;
      } catch (e) {
        // Do not pay for this attempt again in this worker — see `webGpuKnownBad`.
        webGpuKnownBad = true;
        // Include the reason. Previously this said only
        // "webgpu-unavailable-falling-back-to-wasm" while ONNX Runtime's own
        // console.error was the only thing carrying the cause — so the user saw a
        // raw "Can't create a session … Missing required scale" and no explanation
        // that we had recovered from it.
        self.postMessage({
          type: "progress",
          status: "webgpu-unavailable-falling-back-to-wasm",
          message:
            e instanceof Error
              ? e.message.slice(0, 300)
              : String(e).slice(0, 300),
        });
      }
    }
    const t = await pipeline("automatic-speech-recognition", model, {
      device: "wasm",
      dtype: "q8",
      progress_callback,
    });
    loadedDevice = "wasm";
    return t as AutomaticSpeechRecognitionPipeline;
  })();

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
      loadedModel = msg.model ?? DEFAULT_MODEL;
      await getTranscriber(loadedModel);
      self.postMessage({ type: "ready", device: loadedDevice });
      return;
    }
    if (msg.type === "transcribe") {
      // `loadedModel`, not DEFAULT_MODEL: a transcribe arriving before any load
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
    self.postMessage({
      type: "error",
      id: msg.type === "transcribe" ? msg.id : undefined,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
