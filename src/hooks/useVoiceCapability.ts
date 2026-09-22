/**
 * Whether the composer can dictate at all, and by which route.
 *
 * The mic used to be unconditional, because the fallback was a free on-device
 * model that always "worked". That model is gone (see `useVoiceInput.ts`), so the
 * button has to answer a question it never had to answer before: is there
 * anything to transcribe WITH?
 *
 * Two independent routes, and either one is enough:
 *
 *  - **BYOK** — a provider the user has a key for that also exposes an
 *    audio-input model. Model-independent: it works on Anthropic, which has no
 *    audio input of its own.
 *  - **The selected model** — when it declares `audio` as an input modality.
 *    Needs no key, which is what makes the mic work on Atlarix Core.
 *
 * Neither → `null`, and the button renders nothing. Same shape as the
 * Deep-thinking toggle, and for the same reason: a control that appears and then
 * fails is worse than one that was never offered.
 *
 * ## `supportsAudioInput` is READ OFF THE MODEL ROW, not computed here
 *
 * The capability registries (`modelsDevAudioById`, the Core tier→vendor routing
 * map) are MAIN-PROCESS module state. Calling `detectAudioCapability` from the
 * renderer looks equivalent and is not — every lookup misses and the gate falls
 * through to a provider allowlist that contains no Core tier, hiding the mic for
 * the entire Core lineup while the same model on BYOK shows it. That exact bug
 * shipped once for Deep thinking; this follows the fix rather than the bug.
 */

import { useMemo } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useTranscriptionProviders } from "@/hooks/useTranscriptionProviders";

export type VoiceRoute =
  /** Transcribe at a BYOK speech endpoint. `provider` is its id. */
  | { kind: "byok"; provider: string }
  /** Transcribe by sending the clip to the chat model that is already selected. */
  | { kind: "model" };

/**
 * The route to dictate through, or `null` when there is none.
 *
 * `null` while the provider query is still loading is deliberate: the mic
 * appearing a moment late is better than one that appears and then vanishes.
 */
export function useVoiceCapability(): VoiceRoute | null {
  const { settings } = useSettings();
  const { data: byokProviders } = useTranscriptionProviders();
  const { data: modelsByProviders } = useLanguageModelsByProviders();

  const available = byokProviders ?? [];
  // A persisted `"local"` is a setting for an engine that no longer exists, so it
  // reads as "unset" rather than as a provider id that will never resolve.
  const preferred = settings?.voiceTranscriptionProvider;
  const chosen =
    preferred && preferred !== "local"
      ? available.find((p) => p.id === preferred)
      : undefined;

  // A purpose-built speech endpoint is both more accurate on short dictation and
  // orders of magnitude cheaper than asking a frontier chat model to transcribe,
  // so BYOK is preferred whenever one exists — but only ever one the user
  // actually has a key for, which is what this list already means.
  const byokProvider = (chosen ?? available[0])?.id;

  const selected = settings?.selectedModel;
  const modelHearsAudio =
    selected != null &&
    modelsByProviders?.[selected.provider]?.find(
      (m) => m.apiName === selected.name,
    )?.supportsAudioInput === true;

  // Memoised on the two SCALARS rather than returned as a fresh literal: this
  // value is a hook dependency all the way down to the callback a MediaRecorder's
  // `onstop` closes over, and a new object every render would churn every one of
  // them for a route that did not change.
  return useMemo<VoiceRoute | null>(
    () =>
      byokProvider
        ? { kind: "byok", provider: byokProvider }
        : modelHearsAudio
          ? { kind: "model" }
          : null,
    [byokProvider, modelHearsAudio],
  );
}
