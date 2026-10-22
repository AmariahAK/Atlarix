/**
 * Session replay in the app's window (item 12): what is recorded and how often.
 *
 * Only for users with analytics on, and every word masked: a replay shows
 * layout, clicks and scrolling, never chat, code, paths or file names, as text
 * or as pictures. The window's posthog-js records; main only says the rate.
 */

/**
 * Share of opted-in app launches recorded, drawn once per launch. App traffic
 * is a few opted-in sessions a day, so 5-10% would record almost nothing;
 * this gives a handful a day, far under the free tier. The hosted
 * core-models.json's `replay.sampleRate` overrides it without a release.
 */
export const REPLAY_SAMPLE_RATE = 0.25;

let hostedRate: number | null = null;

/** The hosted `replay.sampleRate` (0 to 1); anything else leaves the built-in rate. */
export function setHostedReplaySampleRate(raw: unknown): void {
  hostedRate = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
}

export function replaySampleRate(): number {
  return hostedRate ?? REPLAY_SAMPLE_RATE;
}

/** Attributes a replay keeps: layout only. Every other one (title, alt, href, aria-label, value…) is masked. */
const LAYOUT_ATTRIBUTES = new Set([
  "class",
  "style",
  "role",
  "type",
  "rel",
  "dir",
  "width",
  "height",
  "viewBox",
  "d",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "xmlns",
  "points",
  "cx",
  "cy",
  "r",
  "x",
  "y",
  "rx",
  "ry",
  "transform",
  "tabindex",
  "data-state",
  "data-side",
  "data-orientation",
]);

export function maskAttribute(name: string, value: string): string {
  return LAYOUT_ATTRIBUTES.has(name) ? value : "*".repeat(Math.min(value.length, 8));
}

/** posthog-js's `session_recording`: every text node, input and attribute masked; pictures blocked. */
export const REPLAY_RECORDING_OPTIONS = {
  maskAllInputs: true,
  maskInputOptions: { password: true },
  maskTextSelector: "*",
  maskAttributeFn: (name: string, value: string) => maskAttribute(name, value),
  // A canvas, image or video can show code (the preview, a screenshot); an
  // iframe is the user's own app.
  blockSelector: "canvas, img, video, picture, svg image, iframe, object, embed, [data-ph-block]",
  recordHeaders: false,
  recordBody: false,
  recordCrossOriginIframes: false,
} as const;
