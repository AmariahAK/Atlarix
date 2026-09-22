/**
 * One-time cleanup of the deleted on-device speech model's weights.
 *
 * Until this release, dictation ran whisper-small in the renderer via
 * transformers.js, which cached ~285 MB of ONNX weights in the Cache Storage of
 * the app's own origin. Deleting the engine does not delete that cache — and
 * `userData` is INHERITED across reinstalls, including a Squirrel-to-Store
 * switch, so reinstalling would not clear it either. Anyone who ever dictated
 * would keep carrying the weights of an engine that no longer exists, with the
 * "Clear cache" button that used to remove them gone along with it.
 *
 * Idempotent and silent: it runs at startup, finds nothing on every launch after
 * the first, and is never worth a toast either way. Every failure mode (no
 * `caches` in this context, a storage error) degrades to "left it alone", which
 * costs disk and nothing else.
 */

/** transformers.js names its cache `transformers-cache`; ORT adds its own. */
const LEGACY_CACHE_RE = /transformers|onnx/i;

export async function purgeLegacyVoiceModelCache(): Promise<number> {
  try {
    if (typeof caches === "undefined") return 0;
    const keys = await caches.keys();
    // Matched loosely on purpose — a rename upstream degrades to "cleared
    // nothing" rather than to clearing caches that belong to something else.
    const targets = keys.filter((k) => LEGACY_CACHE_RE.test(k));
    let removed = 0;
    for (const key of targets) {
      if (await caches.delete(key)) removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}
