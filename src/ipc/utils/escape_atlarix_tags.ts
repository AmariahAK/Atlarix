/**
 * Escape dyad/atlarix tags in reasoning / tool content so FE markdown and response
 * processors do not treat model output as real Atlarix tags.
 * v7.1.2: Extended to also escape <atlarix> tags alongside <dyad> tags.
 */
export function escapeAtlarixTags(text: string): string {
  return text
    .replace(/<dyad/gi, "＜dyad")
    .replace(/<\/dyad/gi, "＜/dyad")
    .replace(/<atlarix/gi, "＜atlarix")
    .replace(/<\/atlarix/gi, "＜/atlarix");
}
