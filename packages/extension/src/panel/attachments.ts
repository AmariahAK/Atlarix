/**
 * Files the user attaches, and which tiers can actually read them.
 *
 * THREE TIERS OF SUPPORT, and the first needs no capability at all:
 *
 *   TEXT-ISH (csv, md, txt, json, source code) — read as text and inlined into
 *   the message. Works on EVERY model including Core 1, because it is just
 *   words. This is most of what people attach, and gating it on a vision flag
 *   would refuse a spreadsheet to a model perfectly able to read one.
 *
 *   IMAGES — a native `image_url` part, gated on the tier reporting `image` in
 *   its input modalities.
 *
 *   PDFs — gated SEPARATELY, on `pdf`. Seeing an image and accepting a document
 *   are separate capabilities in every catalog that reports both, and a model
 *   with vision routinely rejects a document part. There is deliberately no
 *   "it has vision so it can probably do PDFs" fallback.
 *
 * WE GATE AHEAD OF TIME, WHICH THE DESKTOP DOES NOT, and the difference is that
 * we know the answer. The desktop sends to any model the user configured and
 * reacts to the rejection, because it cannot enumerate every endpoint someone
 * might point it at. Here the lineup is four tiers the proxy describes to us,
 * so refusing before the round is spent is strictly better — and the refusal can
 * name the tier that WOULD work, which a reaction-to-rejection never can.
 *
 * The copy is ours rather than the desktop's `imageUnsupportedUserMessage()`.
 * That one says "switch to a vision-capable model (e.g. Qwen, Gemini, Claude, or
 * GPT-4o) in chat settings" — a sentence naming models this product does not
 * offer and a settings screen it does not have. Reusing it verbatim would be
 * accurate about the failure and wrong about every instruction.
 */

import type { ContentPart, CoreModel } from "../core/client";
import { PREVIEW_CHARS } from "../attachments/store";
import { extractArchiveText, looksLikeZip } from "./ooxml";

/** How many images may ride one message. */
export const MAX_IMAGES = 8;
/** Per-image ceiling. Beyond this, a data URL alone strains the request. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Per-PDF ceiling. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/**
 * How much one message may carry across all its attachments.
 *
 * Claude for Chrome's own documented number, and the only hard limit either
 * reference client publishes for a browser extension. It bounds the request,
 * not the file: a text file of any size passes, because its body goes to the
 * store and only a preview rides the message.
 */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * How many bytes are sniffed to decide what a file is.
 *
 * The desktop's sample size. Enough for a ZIP's local header and for a binary
 * to show a NUL, and small enough that classifying a 40 MB file costs nothing.
 */
export const SNIFF_BYTES = 8_192;

/**
 * The largest archive we will read into memory to extract.
 *
 * Unlike a text file — which is streamed into the store and never rides the
 * request — an office document has to be held whole to be unzipped, because its
 * table of contents is at the END. A cap keeps a 300 MB archive from freezing
 * the panel; 25 MB is far past any real .docx, and a spreadsheet that large is
 * a database.
 */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

export type AttachmentKind = "text" | "image" | "pdf";

export interface Attachment {
  name: string;
  kind: AttachmentKind;
  size: number;
  /** The MIME type, resolved — never the empty string the OS often reports. */
  type: string;
  /**
   * Text content for `text`; a data URL for `image` and `pdf`.
   *
   * Never truncated. An office document's `data` is its EXTRACTED TEXT, which
   * is why it arrives here as kind `text`: what a model reads of a .docx is its
   * words, and the zip it came in is of no further interest.
   */
  data: string;
}

/**
 * Extensions treated as text regardless of what the OS claims.
 *
 * BY EXTENSION, NOT BY MIME TYPE, because the MIME type a browser reports for a
 * file is frequently empty and often wrong — a `.ts` file arrives as
 * `video/mp2t` (MPEG transport stream) on most systems, and a `.md` as
 * `application/octet-stream`. Believing the OS would refuse source code as
 * video.
 */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "log", "xml", "html", "htm", "css", "scss",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
  "c", "h", "cpp", "hpp", "cs", "php", "swift", "kt", "sh", "bash", "zsh",
  "sql", "graphql", "env", "gitignore", "dockerfile", "makefile", "diff",
  "patch", "srt", "vtt",
]);

const IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : name.toLowerCase();
}

/**
 * What kind of thing this is from its NAME alone, or null to go and look.
 *
 * Null is no longer a refusal — it means "the name did not settle it", and the
 * caller sniffs the bytes. That is the difference between the old allowlist,
 * which turned away anything it had not been told about, and the desktop's rule,
 * which turns away only what it has actually looked at and cannot read.
 */
export function classify(name: string, type: string): AttachmentKind | null {
  const mime = type.toLowerCase();
  if (mime === "application/pdf" || extensionOf(name) === "pdf") return "pdf";
  if (IMAGE_TYPES.has(mime) || mime.startsWith("image/")) return "image";
  if (TEXT_EXTENSIONS.has(extensionOf(name))) return "text";
  // A declared text MIME is believed even for an unknown extension — that is
  // how `text/x-something` and a file with no extension at all get through.
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return null;
}

/** The MIME type we record for each office format we can read. */
const OFFICE_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  epub: "application/epub+zip",
};

/**
 * Do these bytes look like text?
 *
 * A NUL BYTE IS THE TELL. No text encoding this decodes puts one in the middle
 * of a document, and essentially every binary format does within its first few
 * kilobytes. Combined with a strict UTF-8 decode — which throws on an invalid
 * sequence rather than substituting — that is the desktop's `classifyContent`
 * and it is right far more often than any extension list.
 *
 * A file whose first 8 KB are clean but which turns binary later reads as text.
 * That is the correct way round: the failure is a messy paste, not a refusal of
 * something readable.
 */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return true;
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return true;
  } catch {
    return false;
  }
}

/** What a tier can accept, from the catalog the proxy reports. */
export interface TierCapability {
  images: boolean;
  pdfs: boolean;
  /** Unknown means the proxy reported no modalities at all. */
  known: boolean;
}

export function capabilityOf(model: CoreModel | undefined): TierCapability {
  const modalities = model?.inputModalities ?? [];
  return {
    images: modalities.includes("image"),
    pdfs: modalities.includes("pdf"),
    known: modalities.length > 0,
  };
}

/**
 * Which tiers could read this kind of file, for naming one in a refusal.
 *
 * A REFUSAL THAT NAMES THE WAY FORWARD, rather than one that states a fact. "I
 * cannot see images" leaves the user to go and find out which tier can; "Core 3
 * can" is the same sentence with the work done.
 */
export function tiersSupporting(
  lineup: CoreModel[],
  kind: AttachmentKind,
): string[] {
  if (kind === "text") return [];
  return lineup
    .filter((m) => capabilityOf(m).known)
    .filter((m) => (kind === "image" ? capabilityOf(m).images : capabilityOf(m).pdfs))
    .map((m) => tierName(m.tier))
    .filter(Boolean);
}

function tierName(tier: string): string {
  const match = /^core-(\d+)$/.exec(tier);
  return match ? `Core ${match[1]}` : tier;
}

export interface GateResult {
  accepted: Attachment[];
  /**
   * The ones that did not go, so the caller can KEEP THEM STAGED.
   *
   * The refusal says "switch tier and send again", and that sentence was a lie:
   * the composer cleared every attachment on send, so following the advice
   * meant finding the file again. A refused attachment is the one case where
   * the user has been told to do something that needs it still being there.
   */
  rejected: Attachment[];
  /** One sentence per refused attachment, written for the user. */
  refusals: string[];
}

/**
 * Decide what may be sent on this tier.
 *
 * Text always passes. Images and PDFs pass only when the catalog says the tier
 * accepts them — and an UNKNOWN catalog passes too, deliberately: the proxy
 * reporting no modalities means models.dev had no row, not that the model is
 * blind. Refusing on missing metadata would break a working attachment because
 * a third-party catalog was incomplete, which is the wrong way to be wrong.
 * The provider's own rejection is the backstop for that case.
 */
export function gateAttachments(
  attachments: Attachment[],
  model: CoreModel | undefined,
  lineup: CoreModel[],
): GateResult {
  const capability = capabilityOf(model);
  const accepted: Attachment[] = [];
  const rejected: Attachment[] = [];
  const refusals: string[] = [];
  let images = 0;
  let mediaBytes = 0;

  for (const attachment of attachments) {
    if (attachment.kind === "text") {
      accepted.push(attachment);
      continue;
    }

    const supported =
      !capability.known ||
      (attachment.kind === "image" ? capability.images : capability.pdfs);

    if (!supported) {
      const tiers = tiersSupporting(lineup, attachment.kind);
      const noun = attachment.kind === "image" ? "images" : "PDFs";
      refusals.push(
        tiers.length > 0
          ? `${attachment.name} was not sent — ${tierName(model?.tier ?? "")} cannot read ${noun}. ` +
            `${tiers.join(" or ")} can; switch tier and send again.`
          : `${attachment.name} was not sent — no Atlarix Core tier currently reads ${noun}.`,
      );
      rejected.push(attachment);
      continue;
    }

    // THE MESSAGE CEILING APPLIES TO MEDIA ONLY, and that is not an oversight:
    // a text file's body no longer rides the request — it goes to the store and
    // the message carries a preview — so a 30 MB log costs the request nothing.
    // Images and PDFs really are sent, as base64, every round.
    if (mediaBytes + attachment.data.length > MAX_MESSAGE_BYTES) {
      refusals.push(
        `${attachment.name} was not sent — one message carries at most ` +
          `${Math.round(MAX_MESSAGE_BYTES / 1024 / 1024)} MB of images and PDFs. ` +
          `Send it on its own.`,
      );
      rejected.push(attachment);
      continue;
    }
    mediaBytes += attachment.data.length;

    if (attachment.kind === "image") {
      if (images >= MAX_IMAGES) {
        refusals.push(
          `${attachment.name} was not sent — a message carries at most ${MAX_IMAGES} images.`,
        );
        rejected.push(attachment);
        continue;
      }
      images += 1;
    }

    accepted.push(attachment);
  }

  return { accepted, rejected, refusals };
}

/**
 * The header of a text part that carries an attached file.
 *
 * ONE DEFINITION FOR BOTH DIRECTIONS. `attachedTextPart` writes it and
 * `readAttachedText` reads it back, so the shape cannot drift into two
 * disagreeing copies — the panel's transcript and the model's instructions both
 * depend on recognising exactly what the builder emitted.
 *
 * WHAT CHANGED AND WHY. This used to carry the WHOLE file, which is what forced
 * the 200,000-character truncation: a transcript is re-sent in full on every
 * round, so an inlined log was paid for on every round and filled the context
 * window on the second one. Now it carries a preview and an id, the body lives
 * in `attachments/store.ts`, and `read_attachment` pages the rest. Nothing is
 * truncated any more — it is paged, which is the desktop's answer to the same
 * constraint.
 */
const ATTACHED_HEADER = "Attached file: ";

/** What an attached text file looks like on the wire. */
export function attachedTextPart(file: StoredRef): ContentPart {
  const whole = file.chars <= PREVIEW_CHARS;
  const preview = whole ? file.preview : file.preview.slice(0, PREVIEW_CHARS);
  return {
    type: "text",
    text:
      `${ATTACHED_HEADER}${file.name} | id: ${file.id} | ${file.type} | ` +
      `${file.chars.toLocaleString("en-US")} chars\n` +
      (whole
        ? ""
        : `Preview (first ${PREVIEW_CHARS.toLocaleString("en-US")} chars — ` +
          `read_attachment({ attachmentId: "${file.id}" }) pages the FULL file):\n`) +
      // Fenced so a CSV's commas do not read as prose, and so the boundary
      // between the file and the question is unambiguous.
      "```\n" +
      preview +
      "\n```",
  };
}

/** What `attachedTextPart` needs to know about a file already in the store. */
export interface StoredRef {
  id: string;
  name: string;
  type: string;
  chars: number;
  /** The first `PREVIEW_CHARS` of the body, or all of it when it is shorter. */
  preview: string;
}

export interface AttachedRef {
  id: string;
  name: string;
  type: string;
  chars: number;
  preview: string;
  /** False when the preview IS the whole file, so nothing needs paging. */
  clipped: boolean;
}

/** The file back out of such a part, or null when it is ordinary typed text. */
export function readAttachedText(part: ContentPart): AttachedRef | null {
  if (part.type !== "text" || !part.text.startsWith(ATTACHED_HEADER)) return null;
  const newline = part.text.indexOf("\n");
  if (newline < 0) return null;

  const header = part.text.slice(ATTACHED_HEADER.length, newline);
  // `name | id: … | type | N chars`. Split from the RIGHT, because a filename
  // is the one field that may itself contain " | ".
  const fields = header.split(" | ");
  if (fields.length < 4) return null;
  const chars = Number.parseInt(
    fields[fields.length - 1].replace(/[^0-9]/g, ""),
    10,
  );
  const type = fields[fields.length - 2];
  const idField = fields[fields.length - 3];
  if (!idField.startsWith("id: ")) return null;
  const id = idField.slice(4);
  const name = fields.slice(0, -3).join(" | ");
  if (!name || !id || !Number.isFinite(chars)) return null;

  // Everything between the opening fence and the closing one. A part we wrote
  // always has both; anything else is not ours and is left as typed text.
  const rest = part.text.slice(newline + 1);
  const fence = rest.indexOf("```\n");
  if (fence < 0 || !rest.endsWith("\n```")) return null;
  const preview = rest.slice(fence + 4, -4);

  return { id, name, type, chars, preview, clipped: chars > preview.length };
}

/**
 * Build the message content for a question plus its attachments.
 *
 * THE TEXT COMES FIRST, and the question comes before the files it is about.
 * A model handed four images and then a question re-reads the images with the
 * question in mind; handed the question first, it knows what it is looking for.
 * The same ordering the desktop uses.
 *
 * Returns a plain string when nothing is attached, so an ordinary message stays
 * the shape every stored transcript already holds.
 */
export function buildUserContent(
  text: string,
  attachments: Attachment[],
  stored: Map<string, StoredRef>,
): string | ContentPart[] {
  if (attachments.length === 0) return text;

  const parts: ContentPart[] = [];
  const inlineText = attachments.filter((a) => a.kind === "text");
  const media = attachments.filter((a) => a.kind !== "text");

  // PART ZERO IS ALWAYS WHAT THE USER TYPED, even when that is nothing. It is
  // what `typedText` reads back for the Edit box, and a message whose first part
  // is sometimes the question and sometimes a spreadsheet has no such rule.
  parts.push({ type: "text", text: text.trim() });

  // ONE PART PER ATTACHED FILE, not all of them folded into the question.
  //
  // The model reads the same file either way — but the transcript does not.
  // Folded in, an attached CSV was indistinguishable from text the user had
  // typed, so the panel drew the whole file as the message and the attachment
  // "came through as text" with nothing to show it had ever been a file. Kept as
  // its own part it can be drawn as a chip with a preview behind it.
  for (const file of inlineText) {
    const ref = stored.get(file.name);
    // A file that failed to reach the store is dropped rather than inlined: the
    // alternative is re-introducing the unbounded body this change exists to
    // remove, on exactly the path nobody would test.
    if (ref) parts.push(attachedTextPart(ref));
  }

  for (const file of media) {
    if (file.kind === "image") {
      parts.push({ type: "image_url", image_url: { url: file.data } });
    } else {
      parts.push({
        type: "file",
        file: { filename: file.name, file_data: file.data },
      });
    }
  }
  return parts;
}

/**
 * What was attached to a stored message, for drawing it back.
 *
 * Read out of the message itself rather than from a side store: the bytes are
 * already in the transcript — that is what was sent — so there is nothing to
 * fetch and nothing that can go missing when a conversation is reopened. The
 * desktop keeps a separate `AttachmentStore` and has to survive it being empty;
 * here the message IS the store.
 */
export interface SentAttachment {
  kind: AttachmentKind;
  name: string;
  /** The preview for `text`; a data URL for `image` and `pdf`. */
  data: string;
  /**
   * The store id, for `text` only.
   *
   * The chip expands to the WHOLE file, which the message no longer carries —
   * so the id is how the panel goes and gets it. Absent on a transcript written
   * before the store existed, whose `data` was the whole file already.
   */
  id?: string;
  /** True when `data` is only the first part of the file. */
  clipped?: boolean;
}

export function attachmentsIn(
  content: string | ContentPart[],
): SentAttachment[] {
  if (typeof content === "string") return [];
  const out: SentAttachment[] = [];
  for (const part of content) {
    if (part.type === "image_url") {
      // An image part carries no filename on the wire — the OpenAI shape has
      // nowhere to put one. Naming it by position beats naming it "image" four
      // times over.
      out.push({
        kind: "image",
        name: `Image ${out.filter((a) => a.kind === "image").length + 1}`,
        data: part.image_url.url,
      });
      continue;
    }
    if (part.type === "file") {
      out.push({ kind: "pdf", name: part.file.filename, data: part.file.file_data });
      continue;
    }
    const file = readAttachedText(part);
    if (file) {
      out.push({
        kind: "text",
        name: file.name,
        data: file.preview,
        id: file.id,
        clipped: file.clipped,
      });
    }
  }
  return out;
}

/**
 * What the user actually typed, with the attached files left out.
 *
 * SEPARATE FROM `userText`, which is right to include them: that one measures
 * what the model is sent, and an inlined spreadsheet is genuinely part of it.
 * This one is for the screen and the Edit box, where putting a CSV's contents
 * back in the composer is not editing a question.
 *
 * An older transcript, written when every file was folded into the first part,
 * returns that whole part. Its contents were the message as far as anything ever
 * knew; rewriting history to pretend otherwise would be a guess.
 */
export function typedText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  const part = content.find((p) => p.type === "text" && !readAttachedText(p));
  return part && part.type === "text" ? part.text : "";
}

/**
 * What the user SAID, with every attachment named rather than quoted.
 *
 * THE PROJECTION THE EGRESS RULE NEEDS. `sessions/sync.ts` states that the bytes
 * of a file the user attached are exactly as private as a page the agent read
 * and must not leave the device — and it implemented that with `userText`, whose
 * comment claims it "collapses an attachment to its NAME". That is true of an
 * image and a PDF, whose parts carry no text. It was never true of a TEXT file,
 * which IS a text part: its contents were returned in full and synced, up to the
 * 40,000-character column cap.
 *
 * So the rule was right, the enforcement was not, and the gap was invisible
 * because it lived in the difference between three functions with similar names:
 *
 *   `userText`  — everything the MODEL is sent. Right for the context bar.
 *   `typedText` — only what was typed. Right for the Edit box and the bubble.
 *   `saidText`  — what was typed, plus a NAME per attachment. Right for anything
 *                 that leaves this device.
 */
export function saidText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "image_url") {
      parts.push("[attached image]");
      continue;
    }
    if (part.type === "file") {
      parts.push(`[attached ${part.file.filename}]`);
      continue;
    }
    const file = readAttachedText(part);
    parts.push(file ? `[attached ${file.name}]` : part.text);
  }
  return parts.filter(Boolean).join("\n");
}

/** A short description for the composer's chip. */
export function describeAttachment(a: Attachment): string {
  const kb = Math.max(1, Math.round(a.size / 1024));
  return `${a.name} · ${kb} KB`;
}

/**
 * Read a file into an attachment, or null when it is not something we can read.
 *
 * NO TRUNCATION. A text file arrives whole, however large — the body goes to
 * `attachments/store.ts` and the model pages it with `read_attachment`. The old
 * 200,000-character clip existed only because the body rode inside the message.
 *
 * Size is still checked BEFORE reading for the binary kinds: a 400 MB video read
 * into a data URL would freeze the panel for as long as it took, and then be
 * refused anyway.
 */
export async function readAttachment(
  file: File,
  read: {
    text: (f: File) => Promise<string>;
    dataUrl: (f: File) => Promise<string>;
    /** The first `SNIFF_BYTES`, to decide what the file is. */
    head: (f: File) => Promise<Uint8Array>;
    /** The whole file. Only for an archive, which cannot be read from its head. */
    bytes: (f: File) => Promise<Uint8Array>;
  },
): Promise<{ attachment: Attachment | null; refusal?: string }> {
  const kind = classify(file.name, file.type);

  if (kind === "image" && file.size > MAX_IMAGE_BYTES) {
    return {
      attachment: null,
      refusal: `${file.name} was not attached — it is over the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB limit for images.`,
    };
  }
  if (kind === "pdf" && file.size > MAX_PDF_BYTES) {
    return {
      attachment: null,
      refusal: `${file.name} was not attached — it is over the ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB limit for PDFs.`,
    };
  }

  if (kind === "text") {
    return {
      attachment: {
        name: file.name,
        kind,
        size: file.size,
        type: file.type || "text/plain",
        data: await read.text(file),
      },
    };
  }

  if (kind === "image" || kind === "pdf") {
    return {
      attachment: {
        name: file.name,
        kind,
        size: file.size,
        type: file.type || (kind === "pdf" ? "application/pdf" : "image/*"),
        data: await read.dataUrl(file),
      },
    };
  }

  // EVERYTHING ELSE IS DECIDED BY ITS BYTES, not its name.
  //
  // The desktop settled on this after an extension allowlist missed `.mjs`,
  // `.vue` and `.tf` and could never match a file called `Dockerfile` or
  // `Makefile` at all. It also catches the office documents, which are ZIPs and
  // whose extension may be anything.
  const head = await read.head(file);

  if (looksLikeZip(head)) {
    if (file.size > MAX_ARCHIVE_BYTES) {
      return {
        attachment: null,
        refusal: `${file.name} was not attached — it is over the ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB limit for documents.`,
      };
    }
    // THE WHOLE FILE, NOT THE SNIFF SAMPLE. A ZIP's central directory is at the
    // END — that is the format, not an implementation detail — so a reader
    // handed the first 8 KB finds no directory and concludes the file is not an
    // office document. Every real .docx and .xlsx failed this way, while the
    // tests passed because every fixture was under 500 bytes.
    const extracted = await extractArchiveText(await read.bytes(file));
    if (extracted) {
      return {
        attachment: {
          name: file.name,
          kind: "text",
          size: file.size,
          type: OFFICE_TYPES[extracted.format],
          data: extracted.text,
        },
      };
    }
    return {
      attachment: null,
      refusal:
        `${file.name} was not attached — Atlarix reads Word, Excel, PowerPoint, ` +
        `OpenDocument and EPUB files, but this archive is none of those ` +
        `(a .zip of other files has to be unpacked first).`,
    };
  }

  if (looksLikeText(head)) {
    return {
      attachment: {
        name: file.name,
        kind: "text",
        size: file.size,
        type: file.type || "text/plain",
        data: await read.text(file),
      },
    };
  }

  return {
    attachment: null,
    refusal:
      `${file.name} was not attached — Atlarix reads text and code, images, ` +
      `PDFs, and Word/Excel/PowerPoint/OpenDocument/EPUB documents. This one is ` +
      `binary, so there is nothing to read.`,
  };
}
