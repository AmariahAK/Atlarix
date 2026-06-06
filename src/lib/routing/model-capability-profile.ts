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

/** Providers whose tool-result messages accept image content parts (0.2). */
const TOOL_MEDIA_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
]);

/**
 * v12 2.1 absorbed the 0.2 media gate — the single source of truth for
 * whether tool results may carry image parts (browser_screenshot).
 */
export function providerSupportsToolMedia(
  builtinProviderId: string | undefined,
): boolean {
  return !!builtinProviderId && TOOL_MEDIA_PROVIDERS.has(builtinProviderId);
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
  const supportsToolMedia =
    !!model.builtinProviderId &&
    TOOL_MEDIA_PROVIDERS.has(model.builtinProviderId);

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

/**
 * Apply the profile's tool cap AFTER mode filtering (the documented last
 * stage of the resolution pipeline — see mode-tool-registry.ts).
 * Keep-priority: core tools first, then ascending registry `cost` (the
 * 3.9 follow-up — cost finally weights the toolset). The RETURNED list
 * preserves the input's relative order so downstream manifest rendering
 * stays stable.
 */
export function trimToolsForCapability<
  T extends { name: string; cost?: number },
>(tools: T[], profile: ModelCapabilityProfile, isCore: (t: T) => boolean): T[] {
  if (profile.maxTools == null || tools.length <= profile.maxTools)
    return tools;
  const ranked = [...tools].sort((a, b) => {
    const coreDelta = Number(isCore(b)) - Number(isCore(a));
    if (coreDelta !== 0) return coreDelta;
    return (a.cost ?? 99) - (b.cost ?? 99);
  });
  const keep = new Set(ranked.slice(0, profile.maxTools).map((t) => t.name));
  return tools.filter((t) => keep.has(t.name));
}

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
