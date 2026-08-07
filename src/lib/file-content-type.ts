/**
 * Decide what a file IS by looking at its bytes, not at its name.
 *
 * WHY THIS REPLACED AN EXTENSION LIST
 * -----------------------------------
 * "Can this be read as text?" used to be answered by a 39-entry hardcoded
 * allowlist (`attachment-extensions.ts`). Such a list can never be complete: it was
 * missing 44 common text types including `.mjs`/`.cjs`/`.mts`/`.cts` — which this
 * repo's own config files use — plus `.vue`, `.svelte`, `.scss`, `.ps1`, `.tf`,
 * `.zig`, `.kt`. Files with NO extension (`Dockerfile`, `Makefile`, `LICENSE`,
 * `CODEOWNERS`) could never match at all.
 *
 * It was also wrong in the other direction. macOS registers `.ts` as an MPEG
 * transport stream, so the browser reports `File.type === "video/mp2t"` for a
 * TypeScript file — a name-derived answer that is confidently incorrect.
 *
 * This mirrors what opencode does in `tool/read-filesystem.ts`: magic bytes for
 * images, a NUL byte for binary, and strict UTF-8 decoding for text.
 *
 * WHERE EXTENSIONS ARE STILL RIGHT
 * --------------------------------
 * Content answers "is this readable text". It does NOT answer "which extractor
 * handles this" — a .docx, .xlsx and .pptx are all just ZIP archives, so the caller
 * keeps an extension list for extractor routing. Same reason opencode keeps
 * extension lists for LSP and formatter routing. Content also cannot tell you
 * whether a file is *sensitive*; that is a policy question, deliberately not
 * answered here.
 */

/**
 * Bytes inspected before deciding. Reading a whole file to classify it would mean
 * loading a 500 MB attachment to answer one question. 8 KB is the threshold git
 * uses for the same decision.
 */
export const SNIFF_SAMPLE_BYTES = 8192;

export type ContentKind = "image" | "document" | "text" | "binary";

export interface ContentClassification {
  kind: ContentKind;
  /** Best-known MIME type. `text/plain` for text, a concrete type for images. */
  mime: string;
}

/** Compare `bytes` against a byte signature at `offset`. */
function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** ASCII compare, for text-ish signatures like `%PDF-` and `{\rtf`. */
function startsWithAscii(bytes: Uint8Array, text: string, offset = 0): boolean {
  return startsWith(
    bytes,
    Array.from(text, (c) => c.charCodeAt(0)),
    offset,
  );
}

/**
 * Detect a raster image from its magic bytes, or null.
 *
 * Strictly better than trusting the extension: a JPEG saved as `photo.png` is
 * detected as a JPEG, and a `.ts` file is never mistaken for MPEG video.
 *
 * SVG is deliberately absent — it is XML with no magic number, so it falls through
 * to the text branch. That is the more useful outcome: vision models cannot decode
 * SVG, but they can read and edit its source.
 */
export function detectImageMime(bytes: Uint8Array): string | null {
  // PNG: \x89PNG\r\n\x1a\n
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF87a / GIF89a
  if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) return "image/gif";
  // WEBP: "RIFF" .... "WEBP"
  if (startsWithAscii(bytes, "RIFF") && startsWithAscii(bytes, "WEBP", 8)) return "image/webp";
  // BMP: "BM"
  if (startsWithAscii(bytes, "BM")) return "image/bmp";
  // ICO: 00 00 01 00
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  return null;
}

/**
 * Detect a document container from its magic bytes, or null.
 *
 * Note the deliberate limit: a ZIP signature is as far as content goes. Whether a
 * ZIP is a .docx, .xlsx, .pptx or .odt is answered by the extension, which is why
 * callers keep a document-extension list for extractor routing.
 */
export function detectDocumentSignature(
  bytes: Uint8Array,
): { mime: string; container: "pdf" | "rtf" | "zip" } | null {
  if (startsWithAscii(bytes, "%PDF-")) return { mime: "application/pdf", container: "pdf" };
  if (startsWithAscii(bytes, "{\\rtf")) return { mime: "application/rtf", container: "rtf" };
  // Local file header "PK\x03\x04". Empty (PK\x05\x06) and spanned (PK\x07\x08)
  // archives count too — an empty .docx is still a .docx.
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return { mime: "application/zip", container: "zip" };
  }
  return null;
}

/**
 * A NUL byte in the sample means binary. Same heuristic git uses, and the first
 * check opencode applies (`bytes.includes(0)`).
 */
export function looksBinary(sample: Uint8Array): boolean {
  return sample.includes(0);
}

/**
 * Does the sample decode as strict UTF-8?
 *
 * `stream: true` is load-bearing, not incidental. A fixed-size sample will
 * sometimes cut a multi-byte character in half, and a non-streaming `fatal`
 * decoder throws on that truncated tail — which would misclassify perfectly good
 * UTF-8 as binary for any file with non-ASCII content near the boundary. Streaming
 * mode holds an incomplete trailing sequence for a next chunk that never comes,
 * while still rejecting genuinely invalid bytes.
 */
export function decodesAsUtf8(sample: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify a file from its leading bytes.
 *
 * Order matters: a signature is definitive, so images and document containers are
 * checked before the text heuristics. Only then do we ask whether the bytes look
 * like text.
 *
 * `bytes` may be the whole file or just its head; only the first
 * `SNIFF_SAMPLE_BYTES` are examined either way.
 */
export function classifyContent(bytes: Uint8Array): ContentClassification {
  const sample = bytes.length > SNIFF_SAMPLE_BYTES ? bytes.subarray(0, SNIFF_SAMPLE_BYTES) : bytes;

  const image = detectImageMime(sample);
  if (image) return { kind: "image", mime: image };

  const document = detectDocumentSignature(sample);
  if (document) return { kind: "document", mime: document.mime };

  // An empty file is text: readable, just empty. Treating it as binary would make
  // `touch new.ts` unreadable.
  if (sample.length === 0) return { kind: "text", mime: "text/plain" };

  if (looksBinary(sample)) return { kind: "binary", mime: "application/octet-stream" };
  if (!decodesAsUtf8(sample)) return { kind: "binary", mime: "application/octet-stream" };

  return { kind: "text", mime: "text/plain" };
}

/** Convenience: is this readable as text? */
export function isTextContent(bytes: Uint8Array): boolean {
  return classifyContent(bytes).kind === "text";
}
