/**
 * Sound Notifications
 * ===================
 * Play notification sounds for different events
 */

// Sound file paths - relative to app root
const SOUNDS = {
    notify: "/sounds/notify.wav",
    suggest: "/sounds/suggest.wav",
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
        audio = new Audio(SOUNDS[type]);
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
    } catch (error) {
        // Silently fail - audio may be blocked by browser
        console.debug(`Failed to play ${type} sound:`, error);
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
 * Preload sounds for faster playback
 */
export function preloadSounds(): void {
    Object.keys(SOUNDS).forEach((type) => {
        getAudio(type as SoundType);
    });
}
