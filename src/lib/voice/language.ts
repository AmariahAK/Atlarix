/**
 * Resolve the spoken language passed to the transcription engine.
 *
 * Whisper re-runs language DETECTION on every clip when none is supplied. That
 * is unreliable on short dictation and a wrong guess mis-transcribes the whole
 * utterance — one of the larger accuracy losses in the voice path, and it was
 * happening on every transcript because `language` was never wired through.
 *
 * Resolution order:
 *   1. explicit `voiceLanguage` setting ("auto" = deliberately let Whisper detect)
 *   2. the OS/browser locale — a good default that is NOT a hardcoded "en"
 *   3. undefined → detection, the previous behaviour
 */

/** Normalize a locale tag ("en-GB", "sw_KE") to the ISO-639-1 code Whisper wants. */
function toIso639_1(tag: string): string | undefined {
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  // Two-letter codes only; anything else (e.g. "und", a region-only tag) is not
  // something we can hand to Whisper safely, so fall through to detection.
  return /^[a-z]{2}$/.test(base) ? base : undefined;
}

export function resolveVoiceLanguage(
  setting: string | undefined,
  locale: string | undefined = typeof navigator !== "undefined"
    ? navigator.language
    : undefined,
): string | undefined {
  const configured = setting?.trim();
  if (configured) {
    // Explicit opt-in to per-clip detection.
    if (configured.toLowerCase() === "auto") return undefined;
    return toIso639_1(configured) ?? undefined;
  }
  return locale ? toIso639_1(locale) : undefined;
}
