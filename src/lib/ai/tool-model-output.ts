/**
 * v12 0.2 — typed tool outputs (AI SDK v5 `toModelOutput`).
 *
 * Maps selected tool results to `LanguageModelV2ToolResultOutput` so providers
 * receive native multimodal tool results instead of JSON-stringified text.
 * First (and currently only) consumer: `browser_screenshot` — its base64 PNG
 * becomes a `media` content part the model can actually SEE (TODO 1.3).
 *
 * Provider gating is a coarse media-allowlist by builtinProviderId
 * (opencode-style; the 2.1 capability-profile work will own this properly).
 * Unknown/custom/local providers get a text fallback — never raw base64.
 */

import type { LanguageModelV2ToolResultOutput } from "@ai-sdk/provider";

/** Providers whose tool-result messages accept image content parts. */
const TOOL_MEDIA_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
]);

export function providerSupportsToolMedia(
  builtinProviderId: string | undefined,
): boolean {
  return !!builtinProviderId && TOOL_MEDIA_PROVIDERS.has(builtinProviderId);
}

interface ScreenshotMedia {
  data: string;
  mediaType: string;
  url?: string;
  title?: string;
  note?: string;
}

/**
 * Detect a screenshot payload in either shape:
 * - raw handler result: { success:true, mimeType:"image/png", data, url, title, note }
 * - ToolRegistry envelope: { success:true, result: <raw>, cost, ... }
 */
export function extractScreenshotMedia(output: unknown): ScreenshotMedia | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const candidate =
    o.result && typeof o.result === "object"
      ? (o.result as Record<string, unknown>)
      : o;
  if (candidate.success !== true) return null;
  if (
    typeof candidate.data !== "string" ||
    !candidate.data ||
    typeof candidate.mimeType !== "string" ||
    !candidate.mimeType.startsWith("image/")
  ) {
    return null;
  }
  return {
    data: candidate.data,
    mediaType: candidate.mimeType,
    url: typeof candidate.url === "string" ? candidate.url : undefined,
    title: typeof candidate.title === "string" ? candidate.title : undefined,
    note: typeof candidate.note === "string" ? candidate.note : undefined,
  };
}

function screenshotCaption(media: ScreenshotMedia): string {
  const where = media.url
    ? `${media.url}${media.title ? ` (${media.title})` : ""}`
    : "the open browser page";
  return `Screenshot of ${where}.${media.note ? ` ${media.note}` : ""}`;
}

/**
 * Per-tool adapter for AI SDK `toModelOutput`.
 *
 * Returns `undefined` when the tool has no typed mapping — the caller falls
 * back to today's behavior (text/stringified output).
 */
export function buildToolModelOutput(
  toolName: string,
  output: unknown,
  ctx: { builtinProviderId?: string },
): LanguageModelV2ToolResultOutput | undefined {
  if (toolName !== "browser_screenshot") return undefined;

  const media = extractScreenshotMedia(output);
  if (!media) return undefined; // failure results keep the normal path

  if (providerSupportsToolMedia(ctx.builtinProviderId)) {
    return {
      type: "content",
      value: [
        { type: "text", text: screenshotCaption(media) },
        { type: "media", data: media.data, mediaType: media.mediaType },
      ],
    };
  }

  return {
    type: "text",
    value: `[screenshot captured: ${media.url ?? "current page"}${media.title ? ` (${media.title})` : ""} — this model/provider cannot view images, so the image was not sent. Use browser_read_page for textual page content.]`,
  };
}

/**
 * Display-safe copy of a tool result for activity cards / expand panels:
 * replaces inline base64 image data with a size placeholder so the renderer
 * never serializes megabytes of base64 into a card.
 */
export function redactToolMediaForDisplay(output: unknown): unknown {
  const media = extractScreenshotMedia(output);
  if (!media) return output;

  const replaceData = (obj: Record<string, unknown>): Record<string, unknown> =>
    typeof obj.data === "string" && obj.data.length > 256
      ? { ...obj, data: `[image ${obj.mimeType ?? "binary"} — ${Math.round((obj.data as string).length * 0.75 / 1024)} KB redacted]` }
      : obj;

  const o = output as Record<string, unknown>;
  if (o.result && typeof o.result === "object") {
    return { ...o, result: replaceData(o.result as Record<string, unknown>) };
  }
  return replaceData(o);
}
