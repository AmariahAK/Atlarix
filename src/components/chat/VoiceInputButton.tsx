/**
 * Mic dictation button for the composer. Default engine is free on-device
 * Whisper (transformers.js); Settings can switch to a BYOK cloud provider. Talk,
 * then the transcript is inserted into the composer for review before sending.
 */

import { Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSettings } from "@/hooks/useSettings";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { resolveVoiceLanguage } from "@/lib/voice/language";

/** Whole megabytes — the numbers here are hundreds of MB, so decimals are noise. */
function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_048_576)} MB`;
}

interface VoiceInputButtonProps {
  disabled?: boolean;
  /** Insert transcribed text into the composer (interim replaces, final appends). */
  onInsertText: (text: string, isFinal: boolean) => void;
}

export function VoiceInputButton({
  disabled,
  onInsertText,
}: VoiceInputButtonProps) {
  const { settings } = useSettings();
  const provider = settings?.voiceTranscriptionProvider ?? "local";
  const mode = settings?.voiceInputMode ?? "dictate";
  // Without this the engine got `undefined` and detected the language on every
  // clip — unreliable on short dictation and a silent source of bad transcripts.
  const language = resolveVoiceLanguage(settings?.voiceLanguage);
  const errorShownRef = useRef<string | null>(null);

  const {
    isRecording,
    isTranscribing,
    modelLoadProgress,
    modelLoadBytes,
    error,
    start,
    stop,
    supported,
  } = useVoiceInput({
    provider,
    mode,
    language,
    onTranscript: onInsertText,
  });

  useEffect(() => {
    if (error && error !== errorShownRef.current) {
      errorShownRef.current = error;
      toast.error(error);
    }
    if (!error) errorShownRef.current = null;
  }, [error]);

  if (!supported) return null;

  const loading = modelLoadProgress != null;
  /**
   * The model download deliberately does NOT make the button busy.
   *
   * It used to: `busy` included `loading`, and `busy` disables the button — so on first
   * use the mic was an unclickable spinner for the entire (then ~800 MB) download, which
   * is what "it spins endlessly, no beginning no end, not even usable" described.
   * Recording needs no model; only `transcribe` awaits the pipeline. So you can talk
   * immediately and the transcript arrives once the weights land.
   */
  const busy = isTranscribing;

  const downloadLabel = loading
    ? modelLoadBytes && modelLoadBytes.total > 0
      ? `Downloading speech model… ${Math.round((modelLoadProgress ?? 0) * 100)}% (${formatMegabytes(
          modelLoadBytes.loaded,
        )} of ${formatMegabytes(modelLoadBytes.total)}) — you can start talking now`
      : `Downloading speech model… ${Math.round((modelLoadProgress ?? 0) * 100)}% — you can start talking now`
    : null;

  const title = isRecording
    ? "Stop & transcribe"
    : isTranscribing
      ? "Transcribing…"
      : (downloadLabel ??
        (provider === "local"
          ? "Dictate (on-device)"
          : `Dictate (${provider})`));

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={
              isRecording ? "mx-1 text-red-500 hover:text-red-600" : "mx-1"
            }
            disabled={disabled || (busy && !isRecording)}
            onClick={() => (isRecording ? stop() : void start())}
            title={title}
            aria-label={title}
          >
            {isRecording ? (
              <Square className="h-4 w-4 fill-current animate-pulse" />
            ) : busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              // Still a mic while the model downloads — the button works, so it must not
              // look like it doesn't. Dimming plus the tooltip carries the download; a
              // spinner here would be indistinguishable from the old unusable state.
              <Mic className={loading ? "h-4 w-4 opacity-50" : "h-4 w-4"} />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
