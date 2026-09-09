import type { ModelMessage } from "ai";

/**
 * v10.1 prompt caching — message assembly with provider cache breakpoints.
 *
 * Extracted from the inline block in chat_stream_handlers.ts (simpleStreamText)
 * so the layout is unit-testable (Tier 4 provider message-shape eval) and
 * reusable by the Tier 0.1 unified loop.
 *
 * v13.2: generalized beyond direct Anthropic. Claude-family models need
 * EXPLICIT cache markers on every route (OpenRouter/Compass, Bedrock, Vertex,
 * custom OpenAI-compatible proxies) — without them those routes get zero
 * caching. Mirrors opencode's applyCaching (provider/transform.ts): the marker
 * carries ALL provider option keys at once (the active AI SDK reads its own
 * key and ignores the rest), and only the PLACEMENT branches:
 *  - "message": message-level providerOptions (anthropic, bedrock, vertex)
 *  - "content": marker on the LAST content part (openrouter et al.);
 *    string-content messages fall back to message-level
 *  - "none": no markers (providers with automatic prefix caching — OpenAI,
 *    Gemini, Grok, Groq… — and local models; the stable header/day-stable
 *    tail layout is what serves them)
 *
 * Layout:
 *  1. Stable system header — carries a breakpoint covering tools + system
 *     (the per-turn tail deliberately lives OUTSIDE the `system` field so
 *     this block stays cache-eligible across turns).
 *  2. Optional dynamic tail as its own system-role message (day-stable).
 *  3. History — breakpoints on the LAST TWO history messages: the previous
 *     exchange's tail keeps the growing history caching incrementally, and
 *     the final (new user) message lets the first in-turn step read the
 *     cache right up to it. 3 breakpoints total — under Anthropic's 4 limit.
 */

export type CacheMarkerPlacement = "message" | "content" | "none";

/**
 * Decide marker placement from provider + model. Claude-family detection by
 * model name covers `anthropic/claude-*` (OpenRouter/Compass),
 * `anthropic.claude-*` (Bedrock), and claude-named models on custom proxies.
 */
export function resolveCacheMarkerPlacement(
  builtinProviderId: string | undefined,
  modelName: string | undefined,
): CacheMarkerPlacement {
  if (builtinProviderId === "anthropic") return "message";
  if (!/claude|anthropic/i.test(modelName ?? "")) return "none";
  if (builtinProviderId === "bedrock" || builtinProviderId === "vertex") {
    return "message";
  }
  return "content";
}

// All provider keys at once (opencode pattern) — the SDK in use reads its own.
const CACHE_MARKER = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
  openrouter: { cacheControl: { type: "ephemeral" as const } },
  bedrock: { cachePoint: { type: "default" as const } },
  openaiCompatible: { cache_control: { type: "ephemeral" as const } },
};

// v13.3: header variant — the stable system header survives between-turn
// gaps >5min on direct Anthropic (write costs 2x vs 1.25x; pays off at ≥3
// turns spread over an hour, the typical desktop cadence). Passthrough
// routes keep the plain marker (ttl passthrough is undocumented).
const CACHE_MARKER_HEADER_1H = {
  ...CACHE_MARKER,
  anthropic: {
    cacheControl: { type: "ephemeral" as const, ttl: "1h" as const },
  },
};

type CacheMarker = typeof CACHE_MARKER;
type WithProviderOptions = { providerOptions?: Record<string, unknown> };

function markMessageLevel(
  m: ModelMessage,
  marker: CacheMarker = CACHE_MARKER,
): ModelMessage {
  return {
    ...m,
    providerOptions: {
      ...(m as WithProviderOptions).providerOptions,
      ...marker,
    },
  } as ModelMessage;
}

/** Marker on the last content part; string content → message-level fallback. */
function markContentLevel(m: ModelMessage): ModelMessage {
  const content = (m as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return markMessageLevel(m);
  }
  const last = content[content.length - 1];
  if (last == null || typeof last !== "object") return markMessageLevel(m);
  const markedLast = {
    ...(last as Record<string, unknown>),
    providerOptions: {
      ...(last as WithProviderOptions).providerOptions,
      ...CACHE_MARKER,
    },
  };
  return {
    ...m,
    content: [...content.slice(0, -1), markedLast],
  } as ModelMessage;
}

function mark(m: ModelMessage, placement: CacheMarkerPlacement): ModelMessage {
  return placement === "content" ? markContentLevel(m) : markMessageLevel(m);
}

export function buildStreamMessagesWithCacheBreakpoints(opts: {
  systemHeader: string;
  /** Pre-merged dynamic tail; null/empty → no tail message. */
  dynamicTail?: string | null;
  history: ModelMessage[];
  placement: CacheMarkerPlacement;
  /** Direct Anthropic: 1h TTL on the header breakpoint (v13.3). */
  headerTtl1h?: boolean;
}): ModelMessage[] {
  const { systemHeader, dynamicTail, history, placement, headerTtl1h } = opts;
  const useMarkers = placement !== "none";

  const headerMessage: ModelMessage = { role: "system", content: systemHeader };

  return [
    // System content is a string, so content placement falls back to
    // message-level here regardless — matches opencode's system handling.
    useMarkers
      ? markMessageLevel(
          headerMessage,
          headerTtl1h ? CACHE_MARKER_HEADER_1H : CACHE_MARKER,
        )
      : headerMessage,
    ...(dynamicTail && dynamicTail.trim().length > 0
      ? [{ role: "system" as const, content: dynamicTail }]
      : []),
    // Breakpoints on the last two history messages (unmarked ones pass
    // through by reference — history must stay byte-stable across rounds).
    ...(useMarkers
      ? history.map((m, i) =>
          i >= history.length - 2 ? mark(m, placement) : m,
        )
      : history),
  ];
}

// ── v13.3: per-step breakpoint advancement ─────────────────────────────────
// AI SDK streamText prepares messages once per turn and appends step
// assistant/tool messages internally, so the turn's growing tail would be
// re-sent uncached on every step. opencode avoids this by re-running its
// transform on EVERY request of its own loop; this is the same behavior
// surfaced through `prepareStep`: strip our markers from the history, then
// re-mark the last two messages of the step's input. Header (and any other
// system message) is left untouched — its breakpoint, incl. the 1h TTL,
// must stay byte-stable.

/** Cache key each provider entry carries — strip ONLY these, preserving
 * co-resident providerOptions (e.g. openaiCompatible reasoning fields). */
const CACHE_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic: "cacheControl",
  openrouter: "cacheControl",
  bedrock: "cachePoint",
  openaiCompatible: "cache_control",
};

function stripCacheKeys(
  po: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!po) return po;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [provider, entry] of Object.entries(po)) {
    const cacheKey = CACHE_KEY_BY_PROVIDER[provider];
    if (
      cacheKey &&
      entry != null &&
      typeof entry === "object" &&
      cacheKey in (entry as Record<string, unknown>)
    ) {
      const { [cacheKey]: _removed, ...rest } = entry as Record<
        string,
        unknown
      >;
      changed = true;
      if (Object.keys(rest).length > 0) out[provider] = rest;
    } else {
      out[provider] = entry;
    }
  }
  if (!changed) return po;
  return Object.keys(out).length > 0 ? out : undefined;
}

function stripMessageCacheMarkers(m: ModelMessage): ModelMessage {
  const po = (m as WithProviderOptions).providerOptions;
  const strippedPo = stripCacheKeys(po);
  const content = (m as { content?: unknown }).content;
  let strippedContent = content;
  if (Array.isArray(content)) {
    let anyPartChanged = false;
    const parts = content.map((part) => {
      if (part == null || typeof part !== "object") return part;
      const partPo = (part as WithProviderOptions).providerOptions;
      const strippedPartPo = stripCacheKeys(partPo);
      if (strippedPartPo === partPo) return part;
      anyPartChanged = true;
      const { providerOptions: _po, ...rest } = part as Record<string, unknown>;
      return strippedPartPo != null
        ? { ...rest, providerOptions: strippedPartPo }
        : rest;
    });
    if (anyPartChanged) strippedContent = parts;
  }
  if (strippedPo === po && strippedContent === content) return m;
  const { providerOptions: _mpo, ...restMsg } = m as Record<string, unknown>;
  return {
    ...restMsg,
    ...(strippedPo != null ? { providerOptions: strippedPo } : {}),
    ...(strippedContent !== content ? { content: strippedContent } : {}),
  } as ModelMessage;
}

/**
 * Re-place breakpoints for one streamText step: system messages untouched,
 * markers stripped everywhere else, last two non-system messages marked.
 * No-op (same positions) at step 0 relative to the initial layout. Returns
 * a new array; never mutates the SDK's messages.
 */
export function advanceCacheBreakpointsForStep(
  messages: ModelMessage[],
  placement: CacheMarkerPlacement,
): ModelMessage[] {
  if (placement === "none") return messages;
  const nonSystemIndexes = messages
    .map((m, i) => (m.role === "system" ? -1 : i))
    .filter((i) => i >= 0);
  const markFrom = new Set(nonSystemIndexes.slice(-2));
  return messages.map((m, i) => {
    if (m.role === "system") return m;
    const stripped = stripMessageCacheMarkers(m);
    return markFrom.has(i) ? mark(stripped, placement) : stripped;
  });
}
