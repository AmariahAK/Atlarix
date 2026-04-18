/**
 * Escape dyad tags in reasoning / tool content so FE markdown and response
 * processors do not treat model output as real Atlarix tags.
 */
export function escapeAtlarixTags(text: string): string {
  return text
    .replace(/<dyad/g, "＜dyad")
    .replace(/<\/dyad/g, "＜/dyad");
}
