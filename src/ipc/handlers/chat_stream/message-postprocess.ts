/**
 * Pure message / response post-processing helpers extracted from
 * chat_stream_handlers.ts. No module state — safe to import from anywhere.
 * (Satellite: never imports the parent handler — keeps the run-agent-turn
 * cycle-avoidance intact.)
 */

import log from "electron-log";
import type { ModelMessage } from "ai";
import { removeThinkingTags } from "@/ipc/utils/thinking_tags";

const logger = log.scope("chat-stream:postprocess");

export { removeThinkingTags };

export function formatMessagesForSummary(
  messages: { role: string; content: string | undefined }[],
) {
  if (messages.length <= 8) {
    // If we have 8 or fewer messages, include all of them
    return messages
      .map((m) => `<message role="${m.role}">${m.content}</message>`)
      .join("\n");
  }

  // Take first 2 messages and last 6 messages
  const firstMessages = messages.slice(0, 2);
  const lastMessages = messages.slice(-6);

  // Combine them with an indicator of skipped messages
  const combinedMessages = [
    ...firstMessages,
    {
      role: "system",
      content: `[... ${messages.length - 8} messages omitted ...]`,
    },
    ...lastMessages,
  ];

  return combinedMessages
    .map((m) => `<message role="${m.role}">${m.content}</message>`)
    .join("\n");
}

/** Embedding guards: providers cap per-image payloads (~5MB) and there is no
 * good reason to inline a screenshot-dump's worth of images into one turn. */
const EMBED_IMAGE_MAX_COUNT = 8;
const EMBED_IMAGE_MAX_BASE64_CHARS = 6_800_000; // ≈5MB decoded

// Helper function to convert traditional message with attachments.
// v8.0 removed content blocks in favor of read_attachment; v14.8.11
// (follow-on to W4) restores IMAGE content parts for the CURRENT turn on
// vision-capable dispatches — the model sees an attached image immediately,
// no tool round-trip. Documents keep the read_attachment path (paged, W3);
// historical turns re-read images via read_attachment (ids are stable, W2).
export async function prepareMessageWithAttachments({
  message,
  attachmentInfoForModel,
  imageAttachments = [],
}: {
  message: ModelMessage;
  attachmentInfoForModel: string;
  /** Current-turn image attachments to embed as native image parts. The
   * CALLER gates on vision capability — pass [] for non-vision dispatches. */
  imageAttachments?: Array<{ filename: string; mimeType: string; data: string }>;
}): Promise<ModelMessage> {
  const textContent = message.content;
  if (typeof textContent !== "string") {
    logger.warn(
      "Message content is not a string - shouldn't happen but using message as-is",
    );
    return message;
  }

  // IMPORTANT: Attachment context must be provided to the model, but must NOT be persisted
  // into the user-visible message content in SQLite. We inject it here at dispatch time.
  const injected =
    attachmentInfoForModel && attachmentInfoForModel.trim().length > 0
      ? `${textContent}${attachmentInfoForModel}`
      : textContent;

  const embeddable = imageAttachments
    .filter(
      (a) =>
        a.mimeType.startsWith("image/") &&
        a.mimeType !== "image/svg+xml" &&
        a.data.length > 0 &&
        a.data.length <= EMBED_IMAGE_MAX_BASE64_CHARS,
    )
    .slice(0, EMBED_IMAGE_MAX_COUNT);
  if (embeddable.length === 0) {
    return {
      role: "user",
      content: injected,
    };
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${injected}\n\nThe attached image${embeddable.length > 1 ? "s are" : " is"} embedded below (${embeddable
          .map((a) => a.filename)
          .join(", ")}) — you can view ${embeddable.length > 1 ? "them" : "it"} directly; read_attachment is NOT needed for embedded images.`,
      },
      ...embeddable.map((a) => ({
        type: "image" as const,
        image: a.data,
        mediaType: a.mimeType,
      })),
    ],
  };
}

export function removeNonEssentialTags(text: string): string {
  return removeProblemReportTags(removeThinkingTags(text));
}

export function removeProblemReportTags(text: string): string {
  const problemReportRegex =
    /<atlarix-problem-report[^>]*>[\s\S]*?<\/atlarix-problem-report>/g;
  return text.replace(problemReportRegex, "").trim();
}

export function removeAtlarixTags(text: string): string {
  const legacyDyadBlock = /<dyad-[^>]*>[\s\S]*?<\/dyad-[^>]*>/g;
  // Keep user paste/terminal attachments — ask mode needs these bodies for the model.
  const atlarixBlock =
    /<atlarix-(?!text-attachment|terminal-attachment)[^>]*>[\s\S]*?<\/atlarix-[^>]*>/g;
  return text.replace(legacyDyadBlock, "").replace(atlarixBlock, "").trim();
}

export function hasUnclosedAtlarixWrite(text: string): boolean {
  // Find the last opening atlarix-write tag
  const openRegex = /<atlarix-write[^>]*>/g;
  let lastOpenIndex = -1;
  let match;

  while ((match = openRegex.exec(text)) !== null) {
    lastOpenIndex = match.index;
  }

  // If no opening tag found, there's nothing unclosed
  if (lastOpenIndex === -1) {
    return false;
  }

  // Look for a closing tag after the last opening tag
  const textAfterLastOpen = text.substring(lastOpenIndex);
  const hasClosingTag = /<\/atlarix-write>/.test(textAfterLastOpen);

  return !hasClosingTag;
}
