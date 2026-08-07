import type { FileAttachment } from "@/ipc/ipc_types";

/**
 * `@`-mention attachments. The composer turns an `@file:`/`@dir:` pick into a
 * removable chip (like pasted-text / terminal chips) instead of inline text;
 * on send the token is re-emitted into the prompt so the server-side scoped,
 * capped extraction (parseContextMentions → extractMentionedContext) is
 * unchanged. Mentions carry no `file`, so they are never base64-encoded.
 */
export type MentionAttachment = FileAttachment & {
  mention: NonNullable<FileAttachment["mention"]>;
};

export function isMentionAttachment(
  attachment: FileAttachment,
): attachment is MentionAttachment {
  return Boolean(attachment.mention?.relpath);
}

/** The exact prompt token the dispatch understands (`@file:foo.ts` / `@dir:src`). */
export function mentionToken(att: MentionAttachment): string {
  const { kind, relpath } = att.mention;
  return kind === "dir" ? `@dir:${relpath}` : `@file:${relpath}`;
}

/** Human label for the chip. */
export function mentionDisplayName(kind: "file" | "dir", relpath: string): string {
  return kind === "dir" ? `${relpath}/` : relpath;
}

export type ParsedMention = { kind: "file" | "dir"; relpath: string };

/**
 * Split a SENT user message into its mention tokens and the text around them.
 *
 * `mentionToken()` deliberately re-emits `@file:<relpath>` into the prompt, because
 * the server-side `parseContextMentions → extractMentionedContext` needs it there.
 * But nothing ever turned it back into a chip for display, so a message that was
 * composed by picking a file rendered as the raw string `@file:text.txt` — the
 * attachment looked like text, and there was nothing to preview.
 *
 * This is DISPLAY-ONLY. The stored content keeps its tokens; the renderer shows the
 * `text` and draws chips from `mentions`. Editing a message still edits the real
 * content, tokens intact.
 *
 * Deliberately conservative about what counts as a token: a relpath runs to
 * whitespace, and trailing sentence punctuation is excluded so "see @file:a.ts."
 * does not attach a path ending in a full stop. Backtick-quoted mentions are left
 * alone — inside code they are being talked ABOUT, not used.
 */
export function extractMentions(content: string): {
  text: string;
  mentions: ParsedMention[];
} {
  if (!content || !content.includes("@")) return { text: content, mentions: [] };

  const mentions: ParsedMention[] = [];
  const seen = new Set<string>();
  // Split on inline-code spans so tokens inside backticks are preserved verbatim.
  const segments = content.split(/(`[^`]*`)/g);

  const text = segments
    .map((segment) => {
      if (segment.startsWith("`")) return segment;
      return segment.replace(
        /@(file|dir):([^\s`]+)/g,
        (whole, kind: string, rawPath: string) => {
          // Trailing punctuation belongs to the sentence, not the path, so
          // "see @file:a.ts." must not attach a file called "a.ts.".
          const relpath = rawPath.replace(/[.,;:!?)\]}]+$/, "");
          if (!relpath) return whole;
          const key = `${kind}:${relpath}`;
          if (!seen.has(key)) {
            seen.add(key);
            mentions.push({ kind: kind as "file" | "dir", relpath });
          }
          // The chip stands in for the token; keep only the punctuation we excluded.
          return rawPath.slice(relpath.length);
        },
      );
    })
    .join("");

  return {
    // Removing a token mid-sentence leaves double spaces, and removing one before
    // punctuation leaves " ." — tidy both so the bubble reads normally.
    text: text
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([.,;:!?])/g, "$1")
      .trim(),
    mentions,
  };
}
