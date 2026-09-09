/**
 * Office-XML attachment extraction (.pptx slides, .odt documents).
 * Both formats are zip archives of XML; we unzip with `fflate` (tiny, pure JS)
 * and strip tags — full-fidelity rendering is not the goal, model-readable
 * text is. Mirrors the PDF extractor envelope (success flag, char cap).
 */

import { unzipSync, strFromU8 } from "fflate";

export type OfficeXmlExtractResult = {
  text: string;
  /** Slide count for pptx; 1 for odt. */
  parts: number;
  success: boolean;
};

/** Decode XML entities and collapse the whitespace left behind by tag stripping. */
function xmlToText(xml: string): string {
  return (
    xml
      // Paragraph-ish boundaries become newlines before tags are dropped.
      .replace(/<\/(?:a:p|text:p|text:h)>/g, "\n")
      .replace(/<text:line-break\s*\/>/g, "\n")
      .replace(/<text:tab\s*\/>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// W3 (v14.8.11): no total cap — read_attachment pages the full text per call.
function clip(text: string): string {
  return text;
}

export function extractTextFromPptxBuffer(
  buffer: Buffer,
): OfficeXmlExtractResult {
  try {
    const files = unzipSync(new Uint8Array(buffer));
    // ppt/slides/slide1.xml ... slideN.xml, in deck order.
    const slideNames = Object.keys(files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
        const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
        return na - nb;
      });
    if (slideNames.length === 0) {
      return { text: "", parts: 0, success: false };
    }
    const chunks: string[] = [];
    for (const [i, name] of slideNames.entries()) {
      const body = xmlToText(strFromU8(files[name]));
      if (body) chunks.push(`[Slide ${i + 1}]\n${body}`);
    }
    const text = clip(chunks.join("\n\n"));
    return { text, parts: slideNames.length, success: text.trim().length > 0 };
  } catch {
    return { text: "", parts: 0, success: false };
  }
}

export function extractTextFromOdtBuffer(
  buffer: Buffer,
): OfficeXmlExtractResult {
  try {
    const files = unzipSync(new Uint8Array(buffer));
    const content = files["content.xml"];
    if (!content) {
      return { text: "", parts: 0, success: false };
    }
    const text = clip(xmlToText(strFromU8(content)));
    return { text, parts: 1, success: text.trim().length > 0 };
  } catch {
    return { text: "", parts: 0, success: false };
  }
}
