/**
 * Voice input settings (Settings → AI).
 *
 * The transcription engine could only be changed from the composer's config
 * dropdown, so BYOK voice was effectively undiscoverable — people look in
 * Settings. Both surfaces read and write the same `voiceTranscriptionProvider`
 * setting, so they stay in lockstep; this is a second door, not a second source
 * of truth.
 */

import { useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useTranscriptionProviders } from "@/hooks/useTranscriptionProviders";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { showError, showSuccess } from "@/lib/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Shown while the live list loads or if it errors — voice must never present an
 * empty picker. Mirrors the composer dropdown's fallback.
 */
const FALLBACK_PROVIDERS = [
  { id: "local", label: "On-device (free)" },
  { id: "openai", label: "OpenAI (BYOK)" },
  { id: "groq", label: "Groq (BYOK)" },
  { id: "gemini", label: "Gemini (BYOK)" },
];

/**
 * Deliberately short. Whisper supports ~99 languages, but a wall of them helps
 * nobody — "Auto-detect" covers everything not listed, and the unset default
 * already follows the OS locale (see resolveVoiceLanguage).
 */
const COMMON_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "sw", label: "Swahili" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "hi", label: "Hindi" },
  { code: "zh", label: "Chinese" },
  { code: "ar", label: "Arabic" },
];

/** Sentinel for "follow the OS locale" — distinct from an explicit "auto". */
const SYSTEM = "__system__";

/**
 * Delete the on-device model weights from Cache Storage.
 *
 * The on-device engine fetches ~250-500 MB of ONNX weights on first use and caches
 * them under userData. There was no way to clear that: a load that failed for any
 * reason (interrupted fetch, a quantisation the machine's runtime cannot build a
 * session for) left the user with hundreds of megabytes cached, no retry path, and
 * no recourse short of hand-deleting AppData. Because userData is INHERITED across
 * reinstalls — including a Squirrel-to-Store switch — reinstalling never cleared it
 * either.
 *
 * Runs entirely in the renderer: transformers.js uses the `caches` API, so no IPC.
 */
async function clearOnDeviceModelCache(): Promise<number> {
  if (typeof caches === "undefined") return 0;
  const keys = await caches.keys();
  // transformers.js names its cache "transformers-cache"; match loosely so a rename
  // upstream degrades to "cleared nothing" rather than clearing unrelated caches.
  const targets = keys.filter((k) => /transformers|onnx/i.test(k));
  await Promise.all(targets.map((k) => caches.delete(k)));
  return targets.length;
}

export function VoiceInputSettings() {
  const { settings, updateSettings } = useSettings();
  const { data: liveProviders } = useTranscriptionProviders();
  const [clearing, setClearing] = useState(false);

  const providers =
    liveProviders && liveProviders.length > 0
      ? liveProviders
      : FALLBACK_PROVIDERS;
  const provider = settings?.voiceTranscriptionProvider ?? "local";
  const mode = settings?.voiceInputMode ?? "dictate";
  const language = settings?.voiceLanguage ?? SYSTEM;

  return (
    <div className="mt-6 space-y-4 border-t border-border pt-6">
      <h3 className="text-sm font-medium text-foreground">Voice input</h3>

      <div className="flex items-center justify-between max-w-md gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="voice-provider" className="text-sm">
            Transcription engine
          </Label>
          <p className="text-xs text-muted-foreground">
            On-device is free and private — audio never leaves your machine.
            Cloud engines use your own provider key and are never billed to
            Atlarix Core.
          </p>
        </div>
        <Select
          value={provider}
          onValueChange={(v) =>
            updateSettings({ voiceTranscriptionProvider: v })
          }
        >
          <SelectTrigger id="voice-provider" className="w-44 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between max-w-md gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="voice-language" className="text-sm">
            Spoken language
          </Label>
          <p className="text-xs text-muted-foreground">
            Naming the language is more accurate than letting the model guess it
            from each clip.
          </p>
        </div>
        <Select
          value={language}
          onValueChange={(v) =>
            updateSettings({ voiceLanguage: v === SYSTEM ? undefined : v })
          }
        >
          <SelectTrigger id="voice-language" className="w-44 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SYSTEM}>System default</SelectItem>
            <SelectItem value="auto">Auto-detect</SelectItem>
            {COMMON_LANGUAGES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between max-w-md gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="voice-mode" className="text-sm">
            Mode
          </Label>
          <p className="text-xs text-muted-foreground">
            Dictate transcribes once when you stop — the most accurate. Live
            streams words as you speak (on-device + WebGPU only).
          </p>
        </div>
        <Select
          value={mode}
          onValueChange={(v) =>
            updateSettings({ voiceInputMode: v as "dictate" | "live" })
          }
        >
          <SelectTrigger id="voice-mode" className="w-44 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dictate">Dictate (accurate)</SelectItem>
            <SelectItem value="live">Live (fast)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Only meaningful for the on-device engine — the BYOK engines cache nothing. */}
      {provider === "local" && (
        <div className="flex items-center justify-between max-w-md gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm">Downloaded model</Label>
            <p className="text-xs text-muted-foreground">
              The on-device engine caches its weights after the first use so it works
              offline. Clear them if transcription is stuck or failing — they
              re-download next time you dictate.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={clearing}
            onClick={async () => {
              setClearing(true);
              try {
                const removed = await clearOnDeviceModelCache();
                showSuccess(
                  removed > 0
                    ? "Cached voice model cleared — it will re-download next time you dictate."
                    : "No cached voice model found.",
                );
              } catch (e) {
                showError(e);
              } finally {
                setClearing(false);
              }
            }}
          >
            {clearing ? "Clearing…" : "Clear cache"}
          </Button>
        </div>
      )}
    </div>
  );
}
