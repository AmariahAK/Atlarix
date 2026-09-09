/**
 * useVoiceInput — mic dictation for the composer.
 *
 * Default engine is on-device Whisper (transformers.js in a Web Worker), free
 * and private, provider-independent. An optional BYOK cloud provider
 * (OpenAI / Groq / Gemini) can be selected in settings for max accuracy — it
 * routes the recorded audio through the main process (which holds the key) and
 * never touches Atlarix Core quota.
 *
 * Modes:
 *  - "dictate" (A): record → stop → transcribe the full clip once (most accurate).
 *  - "live" (B): re-transcribe the growing buffer on an interval so words appear
 *    as you speak; the final pass on stop is authoritative. Local + WebGPU only
 *    (WASM is too slow for live) — callers should fall back to "dictate".
 *
 * The hook only produces text; the caller decides where it goes (composer).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";

export type VoiceMode = "dictate" | "live";
/**
 * "local" = on-device Whisper; any other value is a cloud provider id resolved
 * against the live catalog by the main-process handler (endpoint + STT model),
 * so this is intentionally not a closed union.
 */
export type TranscriptionProvider = "local" | (string & {});

export interface UseVoiceInputOptions {
  mode?: VoiceMode;
  provider?: TranscriptionProvider;
  /** Called with the latest transcript (interim in live mode, final on stop). */
  onTranscript: (text: string, isFinal: boolean) => void;
  language?: string;
}

export interface UseVoiceInputState {
  isRecording: boolean;
  isTranscribing: boolean;
  /** 0..1 model-download progress on first local use; null once ready. */
  modelLoadProgress: number | null;
  /** Bytes downloaded so far / expected, so the UI can say how big the wait is. */
  modelLoadBytes: { loaded: number; total: number } | null;
  device: "webgpu" | "wasm" | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  supported: boolean;
}

const LIVE_RETRANSCRIBE_MS = 1500;

/**
 * Whether WebGPU already failed to build a session in this app session.
 *
 * Module-level rather than per-hook because the worker is REPLACED after a failed load
 * (see the error branch below) and a fresh worker resets its own copy of this verdict —
 * so without carrying it here, every rebuild would re-attempt WebGPU and re-fail. Not
 * persisted to disk: a driver or browser update can change the answer, so a fresh app
 * launch is allowed to try once more.
 */
let webGpuFailedThisSession = false;

/**
 * Aggregate download progress across every file the model needs.
 *
 * The hook used to set progress from whichever file reported last, so the bar jumped
 * around — encoder at 80% then a tokenizer file resetting it to 3%. Summing bytes gives
 * one honest number. `Math.max` against the previous value stops it snapping backwards
 * when a new file joins and raises the denominator mid-download.
 */
export function aggregateProgress(
  byFile: Map<string, { loaded: number; total: number }>,
): { progress: number; loaded: number; total: number } {
  let loaded = 0;
  let total = 0;
  for (const entry of byFile.values()) {
    loaded += entry.loaded;
    total += entry.total;
  }
  return { progress: total > 0 ? loaded / total : 0, loaded, total };
}

/** Decode an audio Blob to mono 16 kHz Float32 PCM (Whisper's expected input). */
async function blobToPcm16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();
  const AudioCtx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const decodeCtx = new AudioCtx();
  try {
    const decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
    const frames = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineAudioContext(1, Math.max(frames, 1), 16000);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    void decodeCtx.close();
  }
}

export function useVoiceInput({
  mode = "dictate",
  provider = "local",
  onTranscript,
  language,
}: UseVoiceInputOptions): UseVoiceInputState {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [modelLoadProgress, setModelLoadProgress] = useState<number | null>(
    null,
  );
  const [modelLoadBytes, setModelLoadBytes] = useState<{
    loaded: number;
    total: number;
  } | null>(null);
  const [device, setDevice] = useState<"webgpu" | "wasm" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const liveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reqCounter = useRef(0);
  const pendingLocal = useRef(new Map<string, (text: string) => void>());
  const cancelledRef = useRef(false);
  const progressByFile = useRef(
    new Map<string, { loaded: number; total: number }>(),
  );

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  /**
   * Terminate the worker and resolve anything waiting on it, so nothing can hang.
   *
   * Used both on unmount and after a failed LOAD. A pending `transcribe` whose worker
   * disappears would otherwise never settle, leaving `isTranscribing` true and the
   * spinner running — the exact symptom this whole change is here to remove.
   */
  const teardownWorker = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    for (const resolve of pendingLocal.current.values()) resolve("");
    pendingLocal.current.clear();
    progressByFile.current.clear();
  }, []);

  // Lazily create the local Whisper worker (only when provider === "local").
  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(
      new URL("@/lib/voice/whisper-worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (
      e: MessageEvent<{
        type: string;
        status?: string;
        device?: "webgpu" | "wasm";
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
        id?: string;
        text?: string;
        message?: string;
      }>,
    ) => {
      const m = e.data;
      if (m.type === "progress") {
        // Remember a WebGPU failure for the whole app session, not just this worker —
        // the worker below is replaced on a load error and would otherwise retry it.
        if (m.status === "webgpu-unavailable-falling-back-to-wasm") {
          webGpuFailedThisSession = true;
        }
        if (
          m.file &&
          typeof m.loaded === "number" &&
          typeof m.total === "number" &&
          m.total > 0
        ) {
          progressByFile.current.set(m.file, {
            loaded: m.loaded,
            total: m.total,
          });
          const agg = aggregateProgress(progressByFile.current);
          setModelLoadBytes({ loaded: agg.loaded, total: agg.total });
          setModelLoadProgress((prev) =>
            prev == null ? agg.progress : Math.max(prev, agg.progress),
          );
        } else if (typeof m.progress === "number") {
          // No byte counts on this event — keep the loading state alive without
          // letting a bare percentage regress the aggregate.
          const bare = m.progress / 100;
          setModelLoadProgress((prev) => prev ?? bare);
        }
      } else if (m.type === "diag") {
        // The worker has no IPC of its own; the renderer console isn't captured in
        // the main log, and that log is the only evidence we get from a user's
        // machine. Forward everything it reports.
        IpcClient.getInstance().logVoiceDiag(m.message ?? "");
      } else if (m.type === "ready") {
        setModelLoadProgress(null);
        setModelLoadBytes(null);
        setDevice(m.device ?? "wasm");
      } else if (m.type === "result" && m.id) {
        const resolve = pendingLocal.current.get(m.id);
        pendingLocal.current.delete(m.id);
        resolve?.(m.text ?? "");
      } else if (m.type === "error") {
        // CLEAR THE SPINNER. Only `ready` used to do this, so a failed model load
        // left `modelLoadProgress` set forever — the mic icon spun indefinitely
        // while the error sat in state, which is exactly how a broken on-device
        // load presented: "the mic does nothing but rotate". An error is a
        // terminal outcome for the load, so it must end the loading state too.
        setModelLoadProgress(null);
        setModelLoadBytes(null);
        setError(m.message ?? "Transcription failed");
        if (m.id) {
          pendingLocal.current.get(m.id)?.("");
          pendingLocal.current.delete(m.id);
          return;
        }
        // No `id` means the LOAD failed. Replace the worker rather than reusing it.
        //
        // transformers.js serialises session creation through a module-level promise
        // chain and (before our patch) left it REJECTED after any failure, so the FIRST
        // session failure of a worker's life permanently disabled every session build
        // after it — including the fallback whose job is to recover, and including every
        // retry. A new worker is a new module instance and therefore a clean chain, so
        // this guard holds even if the patch is lost to a dependency bump.
        // `webGpuFailedThisSession` above is what stops the rebuilt worker walking into
        // the same failure again.
        teardownWorker();
      }
    };
    progressByFile.current.clear();
    worker.postMessage({ type: "load", skipWebGpu: webGpuFailedThisSession });
    workerRef.current = worker;
    return worker;
  }, [teardownWorker]);

  const transcribeLocal = useCallback(
    (audio: Float32Array): Promise<string> => {
      const worker = ensureWorker();
      const id = `t${reqCounter.current++}`;
      return new Promise<string>((resolve) => {
        pendingLocal.current.set(id, resolve);
        // Transfer the buffer to avoid a copy.
        worker.postMessage({ type: "transcribe", id, audio, language }, [
          audio.buffer,
        ]);
      });
    },
    [ensureWorker, language],
  );

  const transcribe = useCallback(
    async (blob: Blob, isFinal: boolean) => {
      if (cancelledRef.current) return;
      setIsTranscribing(true);
      try {
        let text = "";
        if (provider === "local") {
          const pcm = await blobToPcm16k(blob);
          // Silence gate: Whisper hallucinates a repeated phrase ("I'm I'm…") on
          // near-silent audio, so skip clips with no real speech energy. Diagnostics
          // are routed to the main log (renderer console isn't captured there).
          let sumSq = 0;
          for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];
          const rms = pcm.length ? Math.sqrt(sumSq / pcm.length) : 0;
          const seconds = pcm.length / 16000;
          IpcClient.getInstance().logVoiceDiag(
            `local transcribe: ${seconds.toFixed(1)}s rms=${rms.toFixed(4)} final=${isFinal}`,
          );
          if (rms < 0.005) {
            IpcClient.getInstance().logVoiceDiag("skipped: near-silent audio");
            if (isFinal && !text) setError(null);
            return;
          }
          text = await transcribeLocal(pcm);
          IpcClient.getInstance().logVoiceDiag(
            `transcript(${text.length} chars): ${text.slice(0, 120)}`,
          );
        } else {
          // BYOK cloud STT — main holds the key; audio is sent as base64.
          const buf = await blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (const b of bytes) binary += String.fromCharCode(b);
          text = await IpcClient.getInstance().transcribeAudioCloud({
            provider,
            mimeType: blob.type || "audio/webm",
            dataBase64: btoa(binary),
            language,
          });
        }
        if (!cancelledRef.current && text) onTranscript(text, isFinal);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Transcription failed");
      } finally {
        setIsTranscribing(false);
      }
    },
    [provider, transcribeLocal, onTranscript, language],
  );

  const start = useCallback(async () => {
    if (!supported || isRecording) return;
    setError(null);
    cancelledRef.current = false;
    try {
      // `{ audio: true }` accepts the browser's call-tuned DSP defaults, and
      // noiseSuppression + autoGainControl are ON by default. Both are built for
      // voice CALLS and measurably hurt ASR: they reshape the spectrum in ways
      // Whisper wasn't trained on, which shows up as approximately-right words.
      // Echo cancellation has nothing to cancel here (no far-end in dictation).
      // Whisper wants mono 16 kHz, so ask the capture graph for it directly
      // rather than resampling down from 48 kHz afterwards.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;
      // Default recorder bitrate is tuned for size, not fidelity. Matters most
      // for BYOK cloud, where this encoded blob is uploaded verbatim (local
      // decodes back to PCM, so it only pays the codec loss once).
      const recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 128_000,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (liveTimerRef.current) {
          clearInterval(liveTimerRef.current);
          liveTimerRef.current = null;
        }
        if (cancelledRef.current || chunksRef.current.length === 0) return;
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        void transcribe(blob, true);
      };
      // Live mode: emit a chunk each interval so we can re-transcribe the
      // growing buffer (local + WebGPU only; WASM/cloud fall back to final-only).
      //
      // `device === "webgpu"`, not `device !== "wasm"`: device is null until the model
      // is ready, and now that recording is allowed DURING the download, the old test
      // was true while loading — so a live session would queue a re-transcribe every
      // 1.5s against a pipeline that doesn't exist yet, then run them all serially once
      // it did. Live requires a device we have positively confirmed.
      const canLive =
        mode === "live" && provider === "local" && device === "webgpu";
      recorder.start(canLive ? LIVE_RETRANSCRIBE_MS : undefined);
      setIsRecording(true);
      if (canLive) {
        liveTimerRef.current = setInterval(() => {
          if (chunksRef.current.length === 0) return;
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || "audio/webm",
          });
          void transcribe(blob, false);
        }, LIVE_RETRANSCRIBE_MS);
      }
    } catch (e) {
      setError(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Microphone permission denied"
          : e instanceof Error
            ? e.message
            : "Could not start microphone",
      );
    }
  }, [supported, isRecording, mode, provider, device, transcribe]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (liveTimerRef.current) {
      clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    chunksRef.current = [];
    setIsRecording(false);
    setIsTranscribing(false);
  }, []);

  // Warm the local model when this composer mounts with the local provider, so
  // the first dictation isn't blocked on a cold model load.
  useEffect(() => {
    if (provider === "local" && supported) ensureWorker();
  }, [provider, supported, ensureWorker]);

  useEffect(() => {
    return () => {
      teardownWorker();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (liveTimerRef.current) clearInterval(liveTimerRef.current);
    };
  }, [teardownWorker]);

  return {
    isRecording,
    isTranscribing,
    modelLoadProgress,
    modelLoadBytes,
    device,
    error,
    start,
    stop,
    cancel,
    supported,
  };
}
