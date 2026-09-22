/**
 * useVoiceInput — mic dictation for the composer.
 *
 * TRANSCRIPTION HAPPENS AT A PROVIDER. There is no on-device engine any more.
 *
 * ## Why the local engine was deleted
 *
 * The default used to be on-device Whisper (`whisper-small` via transformers.js
 * in a Web Worker), warmed whenever the composer mounted. Measured on an 8 GB
 * Mac, one second after that warm began:
 *
 *   idle      total   550 MB   renderer   149 MB   cpu   0%
 *   +1s       total 1,861 MB   renderer 1,530 MB   cpu 508%
 *
 * ~285 MB of weights plus WebGPU shader compilation, thirteen seconds of
 * multi-core saturation, at the moment a session opened — whether or not the
 * microphone was ever touched. The app's own crash snapshot read
 * `systemMemoryUsageMB: 7885 / 8192`. It took the whole machine down twice.
 *
 * No reference harness does this. Claude Code's dictation is a remote service
 * behind an opt-in setting; Cursor's ecosystem runs dictation in separate apps.
 * Nobody materialises a speech model inside an editor's renderer.
 *
 * ## What replaced it
 *
 * Two independent sources, either of which enables the mic:
 *
 *  1. **The model can hear.** `audio` is a first-class input modality in the
 *     models.dev catalog (727 models declare it), so the mic follows whichever
 *     model is selected — the same gate that decides whether images may be
 *     attached, and the same shape as the Deep-thinking toggle.
 *  2. **A BYOK transcription key.** Model-independent, so it works on every
 *     model — including Anthropic, which has no audio input at all.
 *
 * With neither, the button hides rather than appearing and then failing.
 *
 * Audio always leaves through the MAIN process — it holds the keys, and for the
 * model route the provider routing too. The BYOK route is billed to the user's
 * own key and never touches Atlarix Core quota; the model route bills exactly
 * like a turn on that model, which on a Core tier means Core quota.
 *
 * Live mode is gone with the local engine: it re-transcribed a growing buffer
 * every 1.5s, which was only ever viable against a local WebGPU pipeline. Doing
 * that to a metered API would bill every 1.5s for the same audio. Dictation is
 * record → stop → transcribe once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import type { VoiceRoute } from "@/hooks/useVoiceCapability";

export interface UseVoiceInputOptions {
  /**
   * Where to transcribe, from `useVoiceCapability`. Never null here — the button
   * renders nothing when there is no route, so this hook never has to represent
   * "recording with nowhere to send it".
   */
  route: VoiceRoute;
  /** Called with the final transcript. */
  onTranscript: (text: string, isFinal: boolean) => void;
  language?: string;
  /** Only for usage attribution when transcribing through the chat model. */
  chatId?: number;
}

export interface UseVoiceInputState {
  isRecording: boolean;
  isTranscribing: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  supported: boolean;
}

/**
 * The container to record into, best-supported-first.
 *
 * NOT cosmetic. The clip is now always uploaded verbatim to a provider, and the
 * providers do not accept the same set:
 *
 *   - OpenAI `/audio/transcriptions` takes webm, ogg, mp3, wav and more.
 *   - Gemini's inline audio part documents wav, mp3, aiff, aac, ogg and flac —
 *     **webm is not on that list**, and webm is exactly what Chromium's
 *     MediaRecorder produces by default.
 *
 * Ogg/Opus is the one both sides name, so it is asked for first. Chromium does
 * not offer it on every platform, hence the ladder and the final `undefined`,
 * which lets MediaRecorder pick its own default rather than throwing.
 */
const PREFERRED_MIME_TYPES = [
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/webm;codecs=opus",
  "audio/webm",
] as const;

function pickRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of PREFERRED_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // Some environments throw rather than returning false. Keep looking.
    }
  }
  return undefined;
}

/**
 * `audio/ogg;codecs=opus` → `audio/ogg`.
 *
 * MediaRecorder reports the codec as a media-type PARAMETER, and the provider
 * wire formats want a bare type: Gemini matches `inline_data.mime_type` against a
 * fixed list, and a parameter makes it miss. The codec is discoverable from the
 * container bytes anyway, so nothing is lost by dropping it.
 */
function bareMediaType(mimeType: string): string {
  return (mimeType.split(";")[0] || "").trim();
}

export function useVoiceInput({
  route,
  onTranscript,
  language,
  chatId,
}: UseVoiceInputOptions): UseVoiceInputState {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const transcribe = useCallback(
    async (blob: Blob) => {
      if (cancelledRef.current) return;
      setIsTranscribing(true);
      try {
        // Both routes run in MAIN — it holds the keys and, for the model route,
        // the provider routing. Audio crosses as base64 because the IPC bridge
        // is structured-clone over a contextIsolated boundary.
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a
        // clip of any length, and a per-byte `+=` on a megabyte is slow enough to
        // be visible. 8 KB is comfortably under every engine's spread limit.
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const dataBase64 = btoa(binary);
        const mimeType = bareMediaType(blob.type) || "audio/ogg";
        const ipc = IpcClient.getInstance();
        const text =
          route.kind === "byok"
            ? await ipc.transcribeAudioCloud({
                provider: route.provider,
                mimeType,
                dataBase64,
                language,
              })
            : await ipc.transcribeAudioWithModel({
                mimeType,
                dataBase64,
                language,
                chatId,
              });
        if (!cancelledRef.current && text) onTranscript(text, true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Transcription failed");
      } finally {
        setIsTranscribing(false);
      }
    },
    [route, onTranscript, language, chatId],
  );

  const start = useCallback(async () => {
    if (!supported || isRecording) return;
    setError(null);
    cancelledRef.current = false;
    try {
      // `{ audio: true }` accepts the browser's call-tuned DSP defaults, and
      // noiseSuppression + autoGainControl are ON by default. Both are built for
      // voice CALLS and measurably hurt ASR: they reshape the spectrum in ways
      // speech models weren't trained on, which shows up as approximately-right
      // words. Echo cancellation has nothing to cancel here (no far-end in
      // dictation). Mono 16 kHz is what every STT endpoint wants, so ask the
      // capture graph for it rather than resampling down from 48 kHz after.
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
      // Default recorder bitrate is tuned for size, not fidelity, and this blob
      // is now ALWAYS uploaded verbatim — there is no local decode back to PCM
      // to absorb the codec loss.
      const mimeType = pickRecordingMimeType();
      const recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 128_000,
        ...(mimeType ? { mimeType } : {}),
      });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (cancelledRef.current || chunksRef.current.length === 0) return;
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        void transcribe(blob);
      };
      recorder.start();
      setIsRecording(true);
    } catch (e) {
      setError(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Microphone permission denied"
          : e instanceof Error
            ? e.message
            : "Could not start microphone",
      );
    }
  }, [supported, isRecording, transcribe]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setIsRecording(false);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
    setIsTranscribing(false);
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return {
    isRecording,
    isTranscribing,
    error,
    start,
    stop,
    cancel,
    supported,
  };
}
