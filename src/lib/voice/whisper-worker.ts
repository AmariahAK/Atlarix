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

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let loadedDevice: "webgpu" | "wasm" = "wasm";

/** Load the ASR pipeline, preferring WebGPU and falling back to WASM. */
async function getTranscriber(
  model: string,
): Promise<AutomaticSpeechRecognitionPipeline> {
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
    // Ask for an ADAPTER, not just for the API to exist. Chromium exposes
    // `navigator.gpu` on machines whose GPU cannot actually back it, so the old
    // `typeof navigator.gpu !== "undefined"` check sent us down the WebGPU path
    // anyway — and `onnxruntime-web` logs its own `console.error`
    // ("no available backend found. ERR: [webgpu] … Failed to get GPU adapter")
    // BEFORE the catch below can fall back. Transcription still worked, but every
    // affected user saw a scary error. Observed on Windows 10 hardware that also
    // failed Chromium's DirectComposition probe.
    const hasWebGpu = await (async () => {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } })
        .gpu;
      if (!gpu?.requestAdapter) return false;
      try {
        return Boolean(await gpu.requestAdapter());
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
      } catch {
        self.postMessage({
          type: "progress",
          status: "webgpu-unavailable-falling-back-to-wasm",
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
