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
