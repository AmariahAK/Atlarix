/**
 * PDF text extraction for attachments (shared by upload pre-extract and read_attachment).
 */

import log from "electron-log";

const logger = log.scope("attachment-pdf");

const PDF_EXTRACT_TIMEOUT_MS = 30_000;

export type PdfExtractResult = {
  text: string;
  pages: number;
  success: boolean;
  extractedAt: number;
};

function pdfExtractTimeoutResult(): PdfExtractResult {
  return {
    text: "[PDF extraction timed out after 30s]",
    pages: 0,
    success: false,
    extractedAt: Date.now(),
  };
}

const PDF_JS_TT_WARN = /TT:\s*undefined function/i;

function withPdfJsWarningFilter<T>(fn: () => Promise<T>): Promise<T> {
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = args.map((a) => String(a)).join(" ");
    if (PDF_JS_TT_WARN.test(msg)) return;
    origWarn.apply(console, args as Parameters<typeof console.warn>);
  };
  return fn().finally(() => {
    console.warn = origWarn;
  });
}

async function readPdfFile(
  buffer: Buffer,
): Promise<{ text: string; pages: number; success: boolean }> {
  return withPdfJsWarningFilter(async () => {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const merged =
      typeof text === "string"
        ? text
        : Array.isArray(text)
          ? (text as string[]).join("\n\n")
          : text != null
            ? String(text)
            : "";
    const trimmed = merged.trim();
    return {
      text: trimmed,
      pages: totalPages ?? 0,
      success: Boolean(trimmed),
    };
  });
}

export async function extractTextFromPdfBuffer(
  buffer: Buffer,
): Promise<PdfExtractResult> {
  const started = Date.now();
  const timeout = new Promise<PdfExtractResult>((resolve) => {
    setTimeout(
      () => resolve(pdfExtractTimeoutResult()),
      PDF_EXTRACT_TIMEOUT_MS,
    );
  });

  const result = await Promise.race([
    readPdfFile(buffer).then((r) => ({
      // W3 (v14.8.11): FULL text — read_attachment pages it per call.
      text: r.text,
      pages: r.pages,
      success: r.success,
      extractedAt: Date.now(),
    })),
    timeout,
  ]).catch((err) => ({
    text: `[PDF extraction failed: ${err instanceof Error ? err.message : String(err)}]`,
    pages: 0,
    success: false,
    extractedAt: Date.now(),
  }));

  logger.info("PDF extract finished", {
    success: result.success,
    pages: result.pages,
    chars: result.text.length,
    ms: Date.now() - started,
  });
  return result;
}

export async function preExtractPdfFromBase64(
  base64Data: string,
): Promise<PdfExtractResult | undefined> {
  try {
    return await extractTextFromPdfBuffer(Buffer.from(base64Data, "base64"));
  } catch (err) {
    logger.warn("preExtractPdfFromBase64 failed", err);
    return undefined;
  }
}
