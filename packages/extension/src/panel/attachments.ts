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

/** How many images may ride one message. */
export const MAX_IMAGES = 8;
/** Per-image ceiling. Beyond this, a data URL alone strains the request. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Per-PDF ceiling. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/**
 * How much of a text file is inlined.
 *
 * A cap rather than a refusal: the first 200,000 characters of a CSV answers
 * most questions about it, and "your file is too big" answers none of them. The
 * message says it was truncated, because a silently clipped spreadsheet is one
 * the model will confidently report the wrong total for.
 */
export const MAX_TEXT_CHARS = 200_000;

export type AttachmentKind = "text" | "image" | "pdf";

export interface Attachment {
  name: string;
  kind: AttachmentKind;
  size: number;
  /** Text content for `text`; a data URL for `image` and `pdf`. */
  data: string;
  /** True when `data` is only the beginning of the file. */
  truncated?: boolean;
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

/** What kind of thing this is, or null when we have no way to read it. */
export function classify(name: string, type: string): AttachmentKind | null {
  const mime = type.toLowerCase();
  if (mime === "application/pdf" || extensionOf(name) === "pdf") return "pdf";
  if (IMAGE_TYPES.has(mime)) return "image";
  if (TEXT_EXTENSIONS.has(extensionOf(name))) return "text";
  // A declared text MIME is believed even for an unknown extension — that is
  // how `text/x-something` and a file with no extension at all get through.
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return null;
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
  const refusals: string[] = [];
  let images = 0;

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
      continue;
    }

    if (attachment.kind === "image") {
      if (images >= MAX_IMAGES) {
        refusals.push(
          `${attachment.name} was not sent — a message carries at most ${MAX_IMAGES} images.`,
        );
        continue;
      }
      images += 1;
    }

    accepted.push(attachment);
  }

  return { accepted, refusals };
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
): string | ContentPart[] {
  if (attachments.length === 0) return text;

  const parts: ContentPart[] = [];
  const inlineText = attachments.filter((a) => a.kind === "text");
  const media = attachments.filter((a) => a.kind !== "text");

  const lead = [text.trim()];
  for (const file of inlineText) {
    // Fenced and named. Without the name a model asked "what is in the second
    // file" has no way to tell which is which, and without the fence a CSV's
    // commas read as prose.
    lead.push(
      `Attached file: ${file.name}${file.truncated ? " (truncated — only the first part is shown)" : ""}\n` +
        "```\n" +
        file.data +
        "\n```",
    );
  }
  parts.push({ type: "text", text: lead.filter(Boolean).join("\n\n") });

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

/** A short description for the composer's chip. */
export function describeAttachment(a: Attachment): string {
  const kb = Math.max(1, Math.round(a.size / 1024));
  return `${a.name} · ${kb} KB`;
}

/**
 * Read a file into an attachment, or null when it is not something we can send.
 *
 * Size is checked BEFORE reading: a 400 MB video read into a data URL would
 * freeze the panel for as long as it took, and then be refused anyway.
 */
export async function readAttachment(
  file: File,
  read: {
    text: (f: File) => Promise<string>;
    dataUrl: (f: File) => Promise<string>;
  },
): Promise<{ attachment: Attachment | null; refusal?: string }> {
  const kind = classify(file.name, file.type);
  if (!kind) {
    return {
      attachment: null,
      refusal: `${file.name} was not attached — Atlarix reads text files, images and PDFs.`,
    };
  }

  const limit =
    kind === "image" ? MAX_IMAGE_BYTES : kind === "pdf" ? MAX_PDF_BYTES : Infinity;
  if (file.size > limit) {
    return {
      attachment: null,
      refusal: `${file.name} was not attached — it is over the ${Math.round(limit / 1024 / 1024)} MB limit for ${kind === "image" ? "images" : "PDFs"}.`,
    };
  }

  if (kind === "text") {
    const whole = await read.text(file);
    const truncated = whole.length > MAX_TEXT_CHARS;
    return {
      attachment: {
        name: file.name,
        kind,
        size: file.size,
        data: truncated ? whole.slice(0, MAX_TEXT_CHARS) : whole,
        ...(truncated ? { truncated: true } : {}),
      },
    };
  }

  return {
    attachment: {
      name: file.name,
      kind,
      size: file.size,
      data: await read.dataUrl(file),
    },
  };
}
