/**
 * Escape atlarix tags in reasoning / tool content so FE markdown and response
 * processors do not treat model output as real Atlarix tags.
 */
export function escapeAtlarixTags(text: string): string {
  return text
    .replace(/<atlarix/gi, "＜atlarix")
    .replace(/<\/atlarix/gi, "＜/atlarix");
}
