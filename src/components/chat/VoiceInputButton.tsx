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

interface VoiceInputButtonProps {
  disabled?: boolean;
  /** Insert transcribed text into the composer (interim replaces, final appends). */
  onInsertText: (text: string, isFinal: boolean) => void;
}

export function VoiceInputButton({ disabled, onInsertText }: VoiceInputButtonProps) {
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
  const busy = isTranscribing || loading;

  const title = isRecording
    ? "Stop & transcribe"
    : loading
      ? `Loading speech model… ${Math.round((modelLoadProgress ?? 0) * 100)}%`
      : isTranscribing
        ? "Transcribing…"
        : provider === "local"
          ? "Dictate (on-device)"
          : `Dictate (${provider})`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={
              isRecording
                ? "mx-1 text-red-500 hover:text-red-600"
                : "mx-1"
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
              <Mic className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
