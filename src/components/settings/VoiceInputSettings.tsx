/**
 * Voice input settings (Settings → AI).
 *
 * The transcription engine could only be changed from the composer's config
 * dropdown, so BYOK voice was effectively undiscoverable — people look in
 * Settings. Both surfaces read and write the same `voiceTranscriptionProvider`
 * setting, so they stay in lockstep; this is a second door, not a second source
 * of truth.
 *
 * The on-device engine, its mode toggle and its "Clear cache" button are all
 * gone with the local model (see `useVoiceInput.ts`). What is left is BYOK plus
 * the spoken-language hint, and when there is no BYOK key this section explains
 * the model-audio route rather than offering a picker with nothing in it.
 */

import { useSettings } from "@/hooks/useSettings";
import { useTranscriptionProviders } from "@/hooks/useTranscriptionProviders";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Deliberately short. The STT models behind these providers support ~99
 * languages, but a wall of them helps nobody — "Auto-detect" covers everything
 * not listed, and the unset default already follows the OS locale (see
 * resolveVoiceLanguage).
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

export function VoiceInputSettings() {
  const { settings, updateSettings } = useSettings();
  const { data: liveProviders } = useTranscriptionProviders();

  // No curated fallback: the list is (providers with a key) ∩ (providers with an
  // audio-input model), and empty is a real answer, not a loading artifact.
  const providers = liveProviders ?? [];
  const stored = settings?.voiceTranscriptionProvider;
  // `"local"` named an engine that no longer exists — read it as unset.
  const provider =
    stored && stored !== "local" && providers.some((p) => p.id === stored)
      ? stored
      : (providers[0]?.id ?? "");
  const language = settings?.voiceLanguage ?? SYSTEM;

  return (
    <div className="mt-6 space-y-4 border-t border-border pt-6">
      <h3 className="text-sm font-medium text-foreground">Voice input</h3>

      {providers.length > 0 ? (
        <div className="flex items-center justify-between max-w-md gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="voice-provider" className="text-sm">
              Transcription engine
            </Label>
            <p className="text-xs text-muted-foreground">
              Uses your own provider key and is never billed to Atlarix Core.
              Works on every model, including ones that can't hear.
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
      ) : (
        <p className="max-w-md text-xs text-muted-foreground">
          No transcription key is set. The mic still works on models that accept
          audio — it sends the clip to the model you're on. To dictate on any
          model, add a key for a provider with a speech endpoint (OpenAI, Groq
          or Gemini) in Settings → Providers.
        </p>
      )}

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
    </div>
  );
}
