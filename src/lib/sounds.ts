/**
 * Sound Notifications
 * ===================
 * Play notification sounds for different events.
 * Assets live in public/sounds/ (dev: /sounds/...; packaged file:// uses resolved URLs).
 */

function resolveSoundUrl(file: string): string {
  const base =
    typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL !=
      null
      ? String(
          (import.meta as unknown as { env: { BASE_URL: string } }).env
            .BASE_URL,
        ).replace(/\/$/, "")
      : "";
  const rel = `${base}/sounds/${file}`.replace(/^\//, "");
  if (typeof window !== "undefined" && window.location?.href) {
    try {
      return new URL(rel, window.location.href).href;
    } catch {
      /* fall through */
    }
  }
  return `/${rel}`;
}

const SOUNDS = {
  notify: resolveSoundUrl("notify.wav"),
  suggest: resolveSoundUrl("suggest.wav"),
  remaining: resolveSoundUrl("remaining.mp3"),
} as const;

type SoundType = keyof typeof SOUNDS;

const audioCache = new Map<SoundType, HTMLAudioElement>();
let autoplayUnlocked = false;

// F1: user-controlled notification-sound preferences (fed from settings by the
// renderer, see setSoundPreferences). Default on at full volume so behavior is
// unchanged until the user opts out / adjusts.
let soundEnabled = true;
let soundVolume = 1;

export function setSoundPreferences(prefs: {
  enabled?: boolean;
  volume?: number;
}): void {
  if (typeof prefs.enabled === "boolean") soundEnabled = prefs.enabled;
  if (typeof prefs.volume === "number" && Number.isFinite(prefs.volume)) {
    soundVolume = Math.max(0, Math.min(1, prefs.volume));
  }
}

function unlockAutoplayOnce(): void {
  if (autoplayUnlocked || typeof document === "undefined") return;
  autoplayUnlocked = true;
  const silent = new Audio();
  silent.volume = 0;
  void silent.play().catch(() => {
    autoplayUnlocked = false;
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", unlockAutoplayOnce, {
    once: true,
    passive: true,
  });
  document.addEventListener("keydown", unlockAutoplayOnce, { once: true });
}

function getAudio(type: SoundType): HTMLAudioElement {
  let audio = audioCache.get(type);
  if (!audio) {
    const src = SOUNDS[type];
    audio = new Audio(src);
    audio.addEventListener(
      "error",
      () => {
        console.debug(
          `Sound "${type}" failed to load from ${src} (check public/sounds/)`,
        );
        audioCache.delete(type);
      },
      { once: true },
    );
    audioCache.set(type, audio);
  }
  return audio;
}

export async function playSound(type: SoundType): Promise<void> {
  if (!soundEnabled) return;
  try {
    const audio = getAudio(type);
    audio.volume = soundVolume;
    audio.currentTime = 0;
    await audio.play();
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : "";
    if (name !== "NotAllowedError" && name !== "AbortError") {
      console.debug(`Failed to play ${type} sound:`, error);
    }
  }
}

export function playNotify(): Promise<void> {
  return playSound("notify");
}

export function playRemaining(): Promise<void> {
  return playSound("remaining");
}

export function preloadSounds(): void {
  Object.keys(SOUNDS).forEach((type) => {
    getAudio(type as SoundType);
  });
}
