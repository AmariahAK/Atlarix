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

/**
 * PDF guards, tighter than the image ones on purpose.
 *
 * A PDF page costs far more than an image of the same byte size — the provider
 * rasterises AND text-extracts every page — so a 5 MB document is a much bigger
 * bill than a 5 MB screenshot. Anything over the cap keeps the local text
 * extraction that has always run, which is the correct answer for a long
 * text-based PDF anyway.
 */
const EMBED_PDF_MAX_COUNT = 3;
const EMBED_PDF_MAX_BASE64_CHARS = 4_100_000; // ≈3MB decoded

export const PDF_MIME_TYPE = "application/pdf";

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
  pdfAttachments = [],
}: {
  message: ModelMessage;
  attachmentInfoForModel: string;
  /** Current-turn image attachments to embed as native image parts. The
   * CALLER gates on vision capability — pass [] for non-vision dispatches. */
  imageAttachments?: Array<{
    filename: string;
    mimeType: string;
    data: string;
  }>;
  /**
   * Current-turn PDFs to send as native document parts. The CALLER gates on
   * `detectPdfCapability` — pass [] and the local text extraction runs instead,
   * exactly as it always has.
   *
   * This is the only path by which a SCANNED or image-only PDF can be read at
   * all: extraction returns nothing for those, and the tool says so.
   */
  pdfAttachments?: Array<{ filename: string; mimeType: string; data: string }>;
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

  const embeddablePdfs = pdfAttachments
    .filter(
      (a) =>
        a.mimeType === PDF_MIME_TYPE &&
        a.data.length > 0 &&
        a.data.length <= EMBED_PDF_MAX_BASE64_CHARS,
    )
    .slice(0, EMBED_PDF_MAX_COUNT);

  if (embeddable.length === 0 && embeddablePdfs.length === 0) {
    return {
      role: "user",
      content: injected,
    };
  }

  // One note covering whatever is actually embedded, so the model is not told
  // about images on a PDF-only turn (or vice versa).
  const notes: string[] = [];
  if (embeddable.length > 0) {
    notes.push(
      `The attached image${embeddable.length > 1 ? "s are" : " is"} embedded below (${embeddable
        .map((a) => a.filename)
        .join(
          ", ",
        )}) — you can view ${embeddable.length > 1 ? "them" : "it"} directly; read_attachment is NOT needed for embedded images.`,
    );
  }
  if (embeddablePdfs.length > 0) {
    notes.push(
      `The attached PDF${embeddablePdfs.length > 1 ? "s are" : " is"} embedded below (${embeddablePdfs
        .map((a) => a.filename)
        .join(
          ", ",
        )}) — you can read ${embeddablePdfs.length > 1 ? "them" : "it"} directly, including scanned pages, tables and layout; read_attachment is NOT needed for ${embeddablePdfs.length > 1 ? "them" : "it"}.`,
    );
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${injected}\n\n${notes.join("\n\n")}`,
      },
      // A `file` part with an image media type: AI SDK 7 deprecated the
      // `image` part (it printed "Deprecated: '"image" content part'" on every
      // turn with a screenshot). Same bytes, same providers, as the PDFs below.
      ...embeddable.map((a) => ({
        type: "file" as const,
        data: a.data,
        filename: a.filename,
        mediaType: a.mimeType,
      })),
      ...embeddablePdfs.map((a) => ({
        type: "file" as const,
        data: a.data,
        // Providers surface the filename to the model; without it a multi-PDF
        // turn gives it no way to say WHICH document it is quoting.
        filename: a.filename,
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
  // Keep user paste/terminal attachments — ask mode needs these bodies for the model.
  const atlarixBlock =
    /<atlarix-(?!text-attachment|terminal-attachment)[^>]*>[\s\S]*?<\/atlarix-[^>]*>/g;
  return text.replace(atlarixBlock, "").trim();
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
