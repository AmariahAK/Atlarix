/**
 * Sound Notifications
 * ===================
 * Play notification sounds for different events.
 * Files must live in public/sounds/ so they are served at /sounds/... (Vite/Electron).
 */

const BASE = typeof import.meta !== "undefined" && (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL != null
  ? ((import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL).replace(/\/$/, "")
  : "";

const SOUNDS = {
    notify: `${BASE}/sounds/notify.wav`,
    suggest: `${BASE}/sounds/suggest.wav`,
    remaining: `${BASE}/sounds/remaining.mp3`,  // New permissions arriving
} as const;

type SoundType = keyof typeof SOUNDS;

// Cache audio elements for reuse
const audioCache = new Map<SoundType, HTMLAudioElement>();

/**
 * Get or create an audio element for the given sound
 */
function getAudio(type: SoundType): HTMLAudioElement {
    let audio = audioCache.get(type);
    if (!audio) {
        const src = SOUNDS[type];
        audio = new Audio(src);
        audio.addEventListener(
            "error",
            () => {
                console.debug(`Sound "${type}" failed to load from ${src} (check public/sounds/)`);
                audioCache.delete(type);
            },
            { once: true }
        );
        audioCache.set(type, audio);
    }
    return audio;
}

/**
 * Play a notification sound
 */
export async function playSound(type: SoundType): Promise<void> {
    try {
        const audio = getAudio(type);
        audio.currentTime = 0; // Reset to start
        await audio.play();
    } catch (error: unknown) {
        // NotAllowedError = autoplay policy; AbortError = user/system interrupted
        const name = error instanceof Error ? error.name : "";
        if (name !== "NotAllowedError" && name !== "AbortError") {
            console.debug(`Failed to play ${type} sound:`, error);
        }
    }
}

/**
 * Play notify sound - for AI response completion
 */
export function playNotify(): Promise<void> {
    return playSound("notify");
}

/**
 * Play suggest sound - for suggestions/proposals
 */
export function playSuggest(): Promise<void> {
    return playSound("suggest");
}

/**
 * Play remaining sound - for new permissions arriving after initial batch
 */
export function playRemaining(): Promise<void> {
    return playSound("remaining");
}

/**
 * Preload sounds for faster playback
 */
export function preloadSounds(): void {
    Object.keys(SOUNDS).forEach((type) => {
        getAudio(type as SoundType);
    });
}
