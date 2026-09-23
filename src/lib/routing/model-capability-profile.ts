/**
 * v12 2.1 — per-model capability profiles ("bring any AI" adaptation).
 *
 * Strong models get the full tool surface; clearly-weak/local models get a
 * trimmed toolset (1.6: ask offered 31 tools to a 7B just as it did to
 * Opus — weak models drown in schemas) and lighter parameter schemas.
 *
 * Resolution is catalog-first with a conservative heuristic fallback:
 * the DEFAULT is the FULL surface — only models that are confidently weak
 * (small param-count in the id on an unknown family) are trimmed, because
 * over-trimming breaks tasks while under-trimming merely keeps today's
 * behavior. Ref: opencode SessionTools.resolve / models.dev.
 *
 * This module also owns the tool-media (vision tool results) gate that
 * 0.2 parked in tool-model-output.ts.
 */

import { getCachedOpenRouterModelRow } from "./tier-context-limits";

export interface ModelCapabilityProfile {
  /** Max tools to OFFER per turn; null = no cap (full surface). */
  maxTools: number | null;
  /** "simplified" trims optional params from offered tool schemas. */
  schemaComplexity: "full" | "simplified";
  /** Tool-result messages may carry image content parts (browser_screenshot). */
  supportsToolMedia: boolean;
}

const FULL: ModelCapabilityProfile = {
  maxTools: null,
  schemaComplexity: "full",
  supportsToolMedia: false, // provider-gated below
};

/** Trimmed surface for clearly-weak models. */
const LOW: ModelCapabilityProfile = {
  maxTools: 12,
  schemaComplexity: "simplified",
  supportsToolMedia: false,
};

/**
 * Providers whose tool-result messages natively accept image content parts —
 * the fast path. Other providers are NOT assumed image-blind: a catalog modality
 * lookup (below) lets any vision-capable model (Grok, Pixtral/Qwen-VL via
 * OpenRouter, BYO multimodal endpoints) receive screenshots too.
 */
const NATIVE_VISION_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
]);

/**
 * There is deliberately NO native-provider fast path for PDF, unlike vision.
 *
 * Checked against the models.dev snapshot: Anthropic accepts PDF on 15/15
 * models, but OpenAI on only 15/47 (`gpt-5.2-pro`, `gpt-4.1-nano` and the
 * embedding/image models do not) and Google on 21/41. A provider-level
 * allowlist would therefore be wrong for most of two providers' catalogs — and
 * wrong in the expensive direction, sending megabytes of document to a model
 * that rejects it.
 *
 * The catalog covers all three natives completely, so per-model lookup is both
 * available and strictly more accurate. Unknown resolves to false, which simply
 * means the local text extraction runs, exactly as it always has.
 */

/**
 * Does an OpenRouter-style modality string indicate the model accepts IMAGE
 * input? OpenRouter uses e.g. "text+image->text"; some catalogs say
 * "multimodal". Only the input side (left of "->") matters for vision input.
 */
function modalityAcceptsImages(modality: string | undefined): boolean {
  if (!modality) return false;
  const m = modality.toLowerCase();
  const input = m.includes("->") ? (m.split("->")[0] ?? m) : m;
  return input.includes("image") || input.includes("multimodal");
}

/**
 * v14.8.11 (image-hallucination fix): models.dev input modalities, PUSHED in
 * by models_dev.ts whenever its catalog loads/refreshes (main process). This
 * module stays free of main-only imports (the renderer bundles it via the
 * tool-display path), and the vision gate becomes provider-agnostic: native
 * DeepSeek/Qwen/GLM/… vision models were previously image-blind here because
 * only the 3 hardcoded providers + OpenRouter catalog rows ever matched —
 * observed live as DeepSeek v4 pro (natively multimodal) never receiving an
 * attached image and hallucinating its content from the filename.
 * Keys: `${providerId}:${modelId}` and bare `${modelId}`.
 */
const modelsDevVisionById = new Map<string, boolean>();
/**
 * The same registry for PDF-document input, which models.dev declares as its own
 * `pdf` input modality. Kept as a separate map rather than a field on the vision
 * one because the two genuinely diverge: plenty of models see images but reject a
 * document part, and conflating them is what would send a 2 MB PDF to a model
 * that can only take an image.
 */
const modelsDevPdfById = new Map<string, boolean>();
/**
 * Models that accept AUDIO input.
 *
 * Gates the composer's mic exactly as the vision map gates image attachments.
 * The local Whisper engine that used to make dictation provider-independent is
 * gone — it materialised a ~285 MB model in the renderer on every session start
 * and took an 8 GB machine down twice — so dictation now needs either a model
 * that can hear or a BYOK transcription key, and this is the first half of that
 * question.
 */
const modelsDevAudioById = new Map<string, boolean>();

function registerModality(
  map: Map<string, boolean>,
  providerId: string,
  modelId: string,
  accepts: boolean,
): void {
  map.set(`${providerId}:${modelId}`.toLowerCase(), accepts);
  // Bare id too — callers pass catalog-style ids with or without a vendor
  // prefix. Never let a false overwrite a true from another provider row.
  const bare = modelId.toLowerCase();
  if (accepts || !map.has(bare)) {
    map.set(bare, accepts);
  }
}

export function registerModelsDevVision(
  entries: Array<{
    providerId: string;
    modelId: string;
    acceptsImages: boolean;
    /** Optional so an older/partial caller still registers vision correctly. */
    acceptsPdf?: boolean;
    /** Optional for the same reason. */
    acceptsAudio?: boolean;
  }>,
): void {
  for (const e of entries) {
    registerModality(
      modelsDevVisionById,
      e.providerId,
      e.modelId,
      e.acceptsImages,
    );
    registerModality(
      modelsDevPdfById,
      e.providerId,
      e.modelId,
      e.acceptsPdf === true,
    );
    registerModality(
      modelsDevAudioById,
      e.providerId,
      e.modelId,
      e.acceptsAudio === true,
    );
  }
}

/**
 * The media id call sites pass for ATLARIX AUTO (see `resolveMediaModelId`).
 * Auto has no single model: the proxy sends any step carrying an image or a
 * PDF to a model that reads it, and lifts screenshots out of tool results into
 * a user message, so Auto counts as able to see both — through tool results
 * too — whichever model would have answered a text-only step.
 */
export const ATLARIX_AUTO_MEDIA_ID = "atlarix/auto";

function isAtlarixAutoMedia(
  builtinProviderId: string | undefined,
  modelApiId: string | undefined,
): boolean {
  return builtinProviderId === "compass" && modelApiId === ATLARIX_AUTO_MEDIA_ID;
}

function modalityLookup(
  map: Map<string, boolean>,
  builtinProviderId: string | undefined,
  modelApiId: string,
): boolean | undefined {
  const id = modelApiId.toLowerCase();
  const scoped = builtinProviderId
    ? map.get(`${builtinProviderId.toLowerCase()}:${id}`)
    : undefined;
  if (scoped !== undefined) return scoped;
  const bare = map.get(id);
  if (bare !== undefined) return bare;
  const tail = id.includes("/") ? id.split("/").pop()! : null;
  return tail ? map.get(tail) : undefined;
}

function modelsDevVisionFor(
  builtinProviderId: string | undefined,
  modelApiId: string,
): boolean | undefined {
  return modalityLookup(modelsDevVisionById, builtinProviderId, modelApiId);
}

/**
 * Capability-based vision gate (replaces the old hardcoded 3-provider allowlist
 * so user-supplied / open-weight vision models are no longer handicapped).
 * Known-native providers are always true; everything else resolves from the
 * live OpenRouter catalog modality OR the models.dev modality registry (covers
 * NATIVE open-weight providers, whose ids never match an OpenRouter row).
 * Unknown models fall back to text — never sends raw base64 to a non-vision
 * model.
 */
export function detectVisionCapability(
  builtinProviderId: string | undefined,
  modelApiId?: string,
): boolean {
  if (builtinProviderId && NATIVE_VISION_PROVIDERS.has(builtinProviderId)) {
    return true;
  }
  if (isAtlarixAutoMedia(builtinProviderId, modelApiId)) return true;
  const id = (modelApiId ?? "").trim();
  if (!id) return false;
  if (id.includes("/")) {
    const row = getCachedOpenRouterModelRow(id);
    if (modalityAcceptsImages(row?.architecture?.modality)) return true;
  }
  return modelsDevVisionFor(builtinProviderId, id) === true;
}

/**
 * Does this model accept a native PDF **document** part?
 *
 * Mirrors `detectVisionCapability`, and deliberately does NOT reuse it: seeing
 * images and accepting a document are separate capabilities in every catalog
 * that reports both, and treating them as one would hand a multi-megabyte PDF to
 * a model that can only take an image.
 *
 * False is the safe answer and the status quo — the caller falls back to the
 * local text extraction that has always run, so an unknown model loses nothing.
 * Note this only matters for scanned or layout-heavy PDFs; a text PDF extracts
 * fine either way.
 */
export function detectPdfCapability(
  builtinProviderId: string | undefined,
  modelApiId?: string,
): boolean {
  if (isAtlarixAutoMedia(builtinProviderId, modelApiId)) return true;
  const id = (modelApiId ?? "").trim();
  if (!id) return false;
  return modalityLookup(modelsDevPdfById, builtinProviderId, id) === true;
}

/**
 * Does this model accept AUDIO input?
 *
 * Gates the composer's microphone, the same way `detectPdfCapability` gates a
 * document part. `audio` is a first-class input modality in the catalog — 727
 * models declare it — so this needs no hardcoded list and picks up new models
 * without a release, which is the same reason the vision gate was rewritten
 * this way in v14.8.11.
 *
 * False is the safe answer: with no BYOK transcription key configured the mic is
 * hidden rather than offered and then failing, exactly as the Deep-thinking
 * toggle hides for a model that cannot reason.
 */
export function detectAudioCapability(
  builtinProviderId: string | undefined,
  modelApiId?: string,
): boolean {
  const id = (modelApiId ?? "").trim();
  if (!id) return false;
  return modalityLookup(modelsDevAudioById, builtinProviderId, id) === true;
}

/**
 * v12 2.1 absorbed the 0.2 media gate — whether TOOL RESULTS may carry image
 * parts. v14.8.11: split from detectVisionCapability — this is API-FORMAT
 * capability, not model capability: OpenAI-compatible chat APIs (native
 * DeepSeek/Qwen/…) accept images in USER messages but their tool messages are
 * text-only, so a media part in a tool result gets silently dropped (observed
 * live: a vision-capable DeepSeek "described" an image it never received).
 * Native anthropic/google/openai + OpenRouter-cataloged vision models keep
 * tool-result media; everyone else delivers images via the user-message embed
 * path (detectVisionCapability).
 */
export function providerSupportsToolMedia(
  builtinProviderId: string | undefined,
  modelApiId?: string,
): boolean {
  if (builtinProviderId && NATIVE_VISION_PROVIDERS.has(builtinProviderId)) {
    return true;
  }
  // The proxy lifts Auto's tool-result screenshots into a user message.
  if (isAtlarixAutoMedia(builtinProviderId, modelApiId)) return true;
  const id = (modelApiId ?? "").trim();
  if (id.includes("/")) {
    const row = getCachedOpenRouterModelRow(id);
    if (modalityAcceptsImages(row?.architecture?.modality)) return true;
  }
  return false;
}

/**
 * Known-capable families — ALWAYS full surface, including their small
 * variants (haiku/mini/flash are competent tool callers).
 */
const STRONG_FAMILY =
  /claude|gpt-[45o]|o[134](-|$)|gemini|deepseek|grok|mistral-large|mixtral|command-r|kimi|glm-4|qwen(2\.5)?-(max|plus|72b)|llama-?3\.[13]-70b|llama-?[34]05b/i;

/**
 * Param-count hint for unknown families: ≤13B (7b/8b/3b/1.5b…) reads as a
 * small local model.
 */
const SMALL_PARAM_HINT = /(^|[^0-9])([0-9]{1,2}(\.[0-9])?)\s?b([^a-z0-9]|$)/i;
const SMALL_WORD_HINT = /\bmini\b|\bnano\b|\btiny\b|\bsmall\b|distill/i;

function isSmallParamCount(name: string): boolean {
  const m = SMALL_PARAM_HINT.exec(name);
  if (!m) return false;
  const size = Number.parseFloat(m[2]!);
  return Number.isFinite(size) && size <= 13;
}

export function getCapabilityProfile(model: {
  name: string;
  provider?: string;
  builtinProviderId?: string;
}): ModelCapabilityProfile {
  const name = model.name ?? "";
  // Profile field means TOOL-RESULT media specifically (API-format gate).
  const supportsToolMedia = providerSupportsToolMedia(
    model.builtinProviderId,
    name,
  );

  // Catalog: known-strong families keep the full surface regardless of size
  // suffixes ("gpt-4o-mini", "gemini-flash", "claude-haiku" are capable).
  if (STRONG_FAMILY.test(name)) {
    return { ...FULL, supportsToolMedia };
  }

  // Heuristic fallback for unknown families: a small parameter count (or an
  // explicit small-words marker) on a local/unknown provider reads as a
  // weak local model → trimmed surface.
  const isLocalProvider =
    model.builtinProviderId === "ollama" ||
    model.builtinProviderId === "lmstudio";
  if (
    isSmallParamCount(name) ||
    (isLocalProvider && SMALL_WORD_HINT.test(name))
  ) {
    return { ...LOW, supportsToolMedia };
  }

  // Default: full surface (never degrade a model we can't classify).
  return { ...FULL, supportsToolMedia };
}

// trimToolsForCapability removed in v13 — the tool-count cap is gone at ~22
// tools. getCapabilityProfile (above) and simplifyToolParametersForProfile (the
// parameter-schema simplification for weak models) remain.

/**
 * For "simplified" profiles, drop OPTIONAL parameters beyond the first few —
 * required params and the wire format are untouched (structural rewrites
 * would break the tool handlers), so a weak model sees a smaller schema but
 * every emitted call still executes.
 */
const SIMPLIFIED_OPTIONAL_PARAM_CAP = 3;

export function simplifyToolParametersForProfile(
  parameters: unknown,
  profile: ModelCapabilityProfile,
): unknown {
  if (profile.schemaComplexity !== "simplified") return parameters;
  if (!parameters || typeof parameters !== "object") return parameters;
  const schema = parameters as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (schema.type !== "object" || !schema.properties) return parameters;
  const required = new Set(schema.required ?? []);
  const keptProps: Record<string, unknown> = {};
  let optionalKept = 0;
  for (const [key, value] of Object.entries(schema.properties)) {
    if (required.has(key)) {
      keptProps[key] = value;
      continue;
    }
    if (optionalKept < SIMPLIFIED_OPTIONAL_PARAM_CAP) {
      keptProps[key] = value;
      optionalKept++;
    }
  }
  return { ...schema, properties: keptProps };
}
