/**
 * RTF attachment extraction — in-house control-word stripper (no dependency).
 * Good enough for model-readable text from typical exports; not a renderer.
 */


export type RtfExtractResult = {
  text: string;
  success: boolean;
};

export function extractTextFromRtfBuffer(buffer: Buffer): RtfExtractResult {
  try {
    const raw = buffer.toString("utf-8");
    if (!raw.startsWith("{\\rtf")) {
      return { text: "", success: false };
    }

    let text = raw
      // Binary blobs and embedded objects/pictures (drop group contents).
      // Groups look like `{\fonttbl ...}` or `{\*\themedata ...}` with one
      // level of nesting (font definitions etc.).
      .replace(/\{(?:\\\*)?\\(?:pict|object|fonttbl|colortbl|stylesheet|info|themedata|datastore)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "")
      // \'hh hex escapes → character.
      .replace(/\\'([0-9a-fA-F]{2})/g, (_, h: string) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      // \uN unicode escapes (with optional fallback char to skip).
      .replace(/\\u(-?\d+)\s?\??/g, (_, d: string) => {
        const code = Number(d);
        return String.fromCodePoint(code < 0 ? code + 65536 : code);
      })
      // Paragraph/line control words → newline; tabs → tab.
      .replace(/\\(?:par|line|sect|page)d?\b/g, "\n")
      .replace(/\\tab\b/g, "\t")
      // Remaining control words (with optional numeric arg) and symbols.
      .replace(/\\[a-zA-Z]+-?\d*\s?/g, "")
      .replace(/\\([{}\\~_-])/g, "$1")
      // Group braces.
      .replace(/[{}]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // W3 (v14.8.11): no total cap — read_attachment pages the full text per call.
    return { text, success: text.length > 0 };
  } catch {
    return { text: "", success: false };
  }
}
