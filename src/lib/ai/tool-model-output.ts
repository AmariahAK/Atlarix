/**
 * v12 0.2 — typed tool outputs (AI SDK v5 `toModelOutput`).
 *
 * Maps selected tool results to `LanguageModelV2ToolResultOutput` so providers
 * receive native multimodal tool results instead of JSON-stringified text.
 * Consumers: browser screenshots (browser_inspect mode:"screenshot" /
 * legacy browser_screenshot) and — since W4 (v14.8.11) — user-attached images
 * via read_attachment, which previously reached the model as JSON-stringified
 * (and truncation-corrupted) base64 TEXT it could never view.
 *
 * The gate is the RESULT SHAPE (`success:true` + top-level image mimeType +
 * data), not a tool-name allowlist — any tool that returns that shape gets a
 * real media part, the truncation exemption, and the vision-capability gate.
 *
 * Provider gating lives in the 2.1 capability-profile module (the single
 * source of truth since v12 session 9); re-exported here for existing
 * importers. Unknown/custom/local providers get a text fallback — never
 * raw base64.
 */

import type { LanguageModelV2ToolResultOutput } from "@ai-sdk/provider";
import {
  providerSupportsToolMedia,
  detectVisionCapability,
} from "@/lib/routing/model-capability-profile";
import { redactSecretsInText } from "@/lib/security/redact-secrets";

export { providerSupportsToolMedia };

interface ImageMedia {
  data: string;
  mediaType: string;
  url?: string;
  title?: string;
  note?: string;
  filename?: string;
}

/**
 * Detect an image payload in either shape:
 * - raw handler result: { success:true, mimeType:"image/png", data, ... }
 *   (browser screenshots carry url/title; attachment images carry filename)
 * - ToolRegistry envelope: { success:true, result: <raw>, cost, ... }
 */
export function extractImageMedia(output: unknown): ImageMedia | null {
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
    filename:
      typeof candidate.filename === "string" ? candidate.filename : undefined,
  };
}

function imageCaption(media: ImageMedia): string {
  const where = media.filename
    ? `attached file ${media.filename}`
    : media.url
      ? `${media.url}${media.title ? ` (${media.title})` : ""}`
      : "the open browser page";
  return `Image of ${where}.${media.note ? ` ${media.note}` : ""}`;
}

/**
 * Per-tool adapter for AI SDK `toModelOutput`.
 *
 * Returns `undefined` when the result carries no image media — the caller
 * falls back to today's behavior (text/stringified output).
 */
export function buildToolModelOutput(
  _toolName: string,
  output: unknown,
  ctx: { builtinProviderId?: string; modelApiId?: string },
): LanguageModelV2ToolResultOutput | undefined {
  // W4: the shape check IS the gate (a v13.8 comment already called it "the
  // real gate") — the old browser_inspect/browser_screenshot name allowlist
  // kept read_attachment images out of the media path entirely.
  const media = extractImageMedia(output);
  if (!media) return undefined; // failure/text results keep the normal path

  if (providerSupportsToolMedia(ctx.builtinProviderId, ctx.modelApiId)) {
    return {
      type: "content",
      value: [
        { type: "text", text: imageCaption(media) },
        { type: "media", data: media.data, mediaType: media.mediaType },
      ],
    };
  }

  const subject = media.filename
    ? `attached image ${media.filename}`
    : `screenshot of ${media.url ?? "current page"}${media.title ? ` (${media.title})` : ""}`;

  // Vision-capable model on an API whose TOOL messages are text-only
  // (OpenAI-compatible): the image can't ride this tool result, but it CAN
  // ride a user message — steer the model to the embed path instead of
  // letting it believe it saw something.
  if (
    media.filename &&
    detectVisionCapability(ctx.builtinProviderId, ctx.modelApiId)
  ) {
    return {
      type: "text",
      value: `[attached image ${media.filename} — this provider cannot deliver images through tool results, so you have NOT seen it via this call. If the user attached it in their LATEST message, the image is already embedded there — look at that message directly. Otherwise, ask the user to re-attach the image (a fresh attachment is embedded where you can see it). Do not guess its contents.]`,
    };
  }

  // The wording must FORBID guessing: an earlier "work from its filename/
  // context" phrasing was read by a non-vision dispatch as licence to
  // fabricate a confident description of an image it never saw.
  const recovery = media.filename
    ? "You have NOT seen this image and know nothing about its contents — do not guess or infer anything from its filename. Tell the user plainly that this model cannot view images and ask them to describe it (or switch to a vision-capable model)."
    : 'Use browser_inspect(mode:"text") for textual page content.';
  return {
    type: "text",
    value: `[${subject} — this model/provider cannot view images, so the image was not sent. ${recovery}]`,
  };
}

/**
 * D1 (OUTBOUND): the model-facing TEXT of a non-media tool result, with
 * high-confidence secret shapes masked so raw keys/tokens never reach the
 * provider. This is the outbound counterpart to `redactToolMediaForDisplay`
 * (which only masks the UI copy) — used for the `toModelOutput` text fallback.
 * Conservative patterns only (see redact-secrets.ts): a `.env`/`printenv` dump
 * of an OpenAI/GitHub/AWS/JWT/PEM secret is masked; ordinary content is not.
 */
export function redactedToolTextForModel(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return redactSecretsInText(text);
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

  const media = extractImageMedia(secretSafe);
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
