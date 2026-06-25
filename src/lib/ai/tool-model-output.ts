/**
 * v12 0.2 — typed tool outputs (AI SDK v5 `toModelOutput`).
 *
 * Maps selected tool results to `LanguageModelV2ToolResultOutput` so providers
 * receive native multimodal tool results instead of JSON-stringified text.
 * First (and currently only) consumer: `browser_screenshot` — its base64 PNG
 * becomes a `media` content part the model can actually SEE (TODO 1.3).
 *
 * Provider gating lives in the 2.1 capability-profile module (the single
 * source of truth since v12 session 9); re-exported here for existing
 * importers. Unknown/custom/local providers get a text fallback — never
 * raw base64.
 */

import type { LanguageModelV2ToolResultOutput } from "@ai-sdk/provider";
import { providerSupportsToolMedia } from "@/lib/routing/model-capability-profile";
import { redactSecretsInText } from "@/lib/security/redact-secrets";

export { providerSupportsToolMedia };

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
  ctx: { builtinProviderId?: string; modelApiId?: string },
): LanguageModelV2ToolResultOutput | undefined {
  // v13.8: screenshots arrive via browser_inspect(mode:"screenshot") and the
  // legacy browser_screenshot tool (old sessions). The shape check below is the
  // real gate — extractScreenshotMedia returns null for text/snapshot results.
  if (toolName !== "browser_inspect" && toolName !== "browser_screenshot") {
    return undefined;
  }

  const media = extractScreenshotMedia(output);
  if (!media) return undefined; // failure results keep the normal path

  if (providerSupportsToolMedia(ctx.builtinProviderId, ctx.modelApiId)) {
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
    value: `[screenshot captured: ${media.url ?? "current page"}${media.title ? ` (${media.title})` : ""} — this model/provider cannot view images, so the image was not sent. Use browser_inspect(mode:"text") for textual page content.]`,
  };
}

/** Display-only string fields that may carry tool output (and thus secrets). */
const SECRET_REDACTABLE_FIELDS = [
  "result",
  "value",
  "output",
  "stdout",
  "stderr",
  "content",
  "text",
] as const;

/**
 * D1: mask high-confidence secret shapes in the stringy fields of a tool result
 * for the DISPLAY copy only (activity cards). The model still receives the real,
 * unredacted output — this only keeps raw keys/tokens out of the rendered UI.
 */
function redactSecretsInDisplayShape(output: unknown): unknown {
  if (typeof output === "string") return redactSecretsInText(output);
  if (!output || typeof output !== "object") return output;
  let changed = false;
  const o = output as Record<string, unknown>;
  const next: Record<string, unknown> = { ...o };
  for (const field of SECRET_REDACTABLE_FIELDS) {
    const v = o[field];
    if (typeof v === "string") {
      const red = redactSecretsInText(v);
      if (red !== v) {
        next[field] = red;
        changed = true;
      }
    } else if (v && typeof v === "object") {
      const red = redactSecretsInDisplayShape(v);
      if (red !== v) {
        next[field] = red;
        changed = true;
      }
    }
  }
  return changed ? next : output;
}

/**
 * Display-safe copy of a tool result for activity cards / expand panels:
 * replaces inline base64 image data with a size placeholder so the renderer
 * never serializes megabytes of base64 into a card, AND masks high-confidence
 * secret shapes (D1) so raw keys/tokens never render in the UI.
 */
export function redactToolMediaForDisplay(output: unknown): unknown {
  const secretSafe = redactSecretsInDisplayShape(output);

  const media = extractScreenshotMedia(secretSafe);
  if (!media) return secretSafe;

  const replaceData = (obj: Record<string, unknown>): Record<string, unknown> =>
    typeof obj.data === "string" && obj.data.length > 256
      ? { ...obj, data: `[image ${obj.mimeType ?? "binary"} — ${Math.round((obj.data as string).length * 0.75 / 1024)} KB redacted]` }
      : obj;

  const o = secretSafe as Record<string, unknown>;
  if (o.result && typeof o.result === "object") {
    return { ...o, result: replaceData(o.result as Record<string, unknown>) };
  }
  return replaceData(o);
}
