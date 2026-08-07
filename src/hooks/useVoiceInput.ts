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
  device: "webgpu" | "wasm" | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  supported: boolean;
}

const LIVE_RETRANSCRIBE_MS = 1500;

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
  const [modelLoadProgress, setModelLoadProgress] = useState<number | null>(null);
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

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

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
        device?: "webgpu" | "wasm";
        progress?: number;
        id?: string;
        text?: string;
        message?: string;
      }>,
    ) => {
      const m = e.data;
      if (m.type === "progress") {
        if (typeof m.progress === "number") setModelLoadProgress(m.progress / 100);
      } else if (m.type === "ready") {
        setModelLoadProgress(null);
        setDevice(m.device ?? "wasm");
        IpcClient.getInstance().logVoiceDiag(`model ready on device=${m.device}`);
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
        setError(m.message ?? "Transcription failed");
        if (m.id) {
          pendingLocal.current.get(m.id)?.("");
          pendingLocal.current.delete(m.id);
        }
      }
    };
    worker.postMessage({ type: "load" });
    workerRef.current = worker;
    return worker;
  }, []);

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
      const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 128_000 });
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
      const canLive = mode === "live" && provider === "local" && device !== "wasm";
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
      workerRef.current?.terminate();
      workerRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (liveTimerRef.current) clearInterval(liveTimerRef.current);
    };
  }, []);

  return {
    isRecording,
    isTranscribing,
    modelLoadProgress,
    device,
    error,
    start,
    stop,
    cancel,
    supported,
  };
}
