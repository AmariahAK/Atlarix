/**
 * Per-model reasoning + sampling capability, driven by the models.dev catalog.
 *
 * WHY THIS REPLACES A PROVIDER ALLOWLIST
 * The previous rule was `PROVIDERS_THAT_SUPPORT_THINKING.includes(providerId)` →
 * send `thinking: { type:"enabled", budget_tokens: N }`. That is an
 * Anthropic/Google-shaped block, and it was sent to every model of every listed
 * provider regardless of what that model actually accepts. Providers differ in the
 * KIND of control, not just the amount:
 *
 *   - MiniMax-M3 declares `[{type:"toggle"}]` — on/off, no level. The budget block
 *     means nothing to it, so its reasoning was never actually being controlled.
 *   - MiniMax-M2.7 declares `[]` — reasons natively with no parameter, which is why
 *     the same wrong block LOOKED fine there: it was simply ignored.
 *   - deepseek-v4-pro declares `[{toggle},{effort, values:["high","max"]}]`.
 *   - kimi-k3 declares `[{toggle},{effort, values:["low","high","max"]}]` — note it
 *     never lists "medium", so a global ladder would send a value it rejects.
 *
 * The registry is SYNCHRONOUS on purpose. The Deep-thinking toggle is gated from the
 * renderer (`ChatConfigDropdown`), which cannot await a catalog fetch — so the
 * catalog pushes profiles in on every load, mirroring `registerModelsDevVision`.
 *
 * Renderer-safe: no Node/Electron imports.
 */

/** Canonical effort order. Provider "xhigh" is normalized to "max". */
const EFFORT_ORDER = ["low", "medium", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_ORDER)[number];

export type ReasoningOption = { type: string; values?: string[] };

export type ModelReasoningProfile = {
  reasoning: boolean;
  options: ReasoningOption[];
};

/** Keys: `${providerId}:${modelId}` and bare `${modelId}`, both lowercased. */
const profileById = new Map<string, ModelReasoningProfile>();
const temperatureById = new Map<string, boolean>();

function keyFor(providerId: string | undefined, modelId: string): string {
  return providerId
    ? `${providerId.toLowerCase()}:${modelId.toLowerCase()}`
    : modelId.toLowerCase();
}

/**
 * Publish catalog rows into the sync registries. Called on every models.dev load, so
 * a refreshed catalog takes effect without a restart.
 */
export function registerModelsDevReasoning(
  entries: Array<{
    providerId: string;
    modelId: string;
    profile: ModelReasoningProfile;
    supportsTemperature: boolean;
  }>,
): void {
  for (const e of entries) {
    const scoped = keyFor(e.providerId, e.modelId);
    const bare = e.modelId.toLowerCase();
    profileById.set(scoped, e.profile);
    temperatureById.set(scoped, e.supportsTemperature);
    // Bare id too — callers pass ids with or without a vendor prefix. Don't let one
    // provider's row clobber another's already-registered capability.
    if (!profileById.has(bare)) profileById.set(bare, e.profile);
    if (!temperatureById.has(bare)) temperatureById.set(bare, e.supportsTemperature);
  }
}

function lookup<T>(
  map: Map<string, T>,
  providerId: string | undefined,
  modelId: string,
): T | undefined {
  if (!modelId) return undefined;
  const id = modelId.toLowerCase();
  const scoped = providerId ? map.get(keyFor(providerId, id)) : undefined;
  if (scoped !== undefined) return scoped;
  const bare = map.get(id);
  if (bare !== undefined) return bare;
  const tail = id.includes("/") ? id.split("/").pop()! : null;
  return tail ? map.get(tail) : undefined;
}

/** The catalog's reasoning profile, or undefined when the model isn't known. */
export function reasoningProfileFor(
  providerId: string | undefined,
  modelId: string,
): ModelReasoningProfile | undefined {
  return lookup(profileById, providerId, modelId);
}

/**
 * Whether a `temperature` parameter may be sent.
 *
 * Unknown → true (permissive), matching the catalog-miss convention used across the
 * codebase. Only an explicit `temperature: false` row suppresses it — kimi-k3 being
 * the live case, which today receives `temperature: 0` it does not accept.
 */
export function supportsTemperatureParam(
  providerId: string | undefined,
  modelId: string,
): boolean {
  return lookup(temperatureById, providerId, modelId) ?? true;
}

// ── Effort resolution ────────────────────────────────────────────────────────

function normalizeEffort(value: string): EffortLevel | null {
  const v = value.trim().toLowerCase();
  if (v === "xhigh" || v === "x-high" || v === "very-high") return "max";
  return (EFFORT_ORDER as readonly string[]).includes(v) ? (v as EffortLevel) : null;
}

/** Model-declared effort values, normalized, deduped, in canonical order. */
export function normalizedEffortValues(options: ReasoningOption[]): EffortLevel[] {
  const effort = options.find((o) => o.type === "effort");
  if (!effort || !Array.isArray(effort.values)) return [];
  const seen = new Set<EffortLevel>();
  for (const raw of effort.values) {
    const level = normalizeEffort(String(raw));
    if (level) seen.add(level);
  }
  return EFFORT_ORDER.filter((level) => seen.has(level));
}

/**
 * What to actually send for this model on this turn.
 *
 * `none`     — send nothing (the model does not reason, or declares no control).
 * `toggle`   — enable/disable only; there is no level to pick.
 * `effort`   — a single value, guaranteed to be one the model listed.
 * `budget`   — a token allowance.
 * `unknown`  — the catalog has no row; the caller keeps its legacy provider
 *              heuristic rather than silently dropping reasoning for a model newer
 *              than the last catalog refresh.
 */
export type ReasoningRequest =
  | { kind: "none" }
  | { kind: "toggle"; enabled: boolean }
  | { kind: "effort"; effort: EffortLevel }
  | { kind: "budget"; effortHint: "high" | "max" }
  | { kind: "unknown" };

export type ResolveReasoningArgs = {
  providerId: string | undefined;
  modelId: string;
  /** The user's Deep-thinking toggle. */
  deepThinking: boolean;
};

/**
 * Resolve the reasoning control for a model.
 *
 * Effort levels follow the owner's spec: Deep ON asks for the model's TRUE maximum,
 * Deep OFF sits one step below it. Crucially, "one step below" walks the model's OWN
 * declared values, not a global ladder — kimi-k3 lists `["low","high","max"]`, so OFF
 * is `high`, never the `medium` it would reject.
 */
export function resolveReasoningRequest({
  providerId,
  modelId,
  deepThinking,
}: ResolveReasoningArgs): ReasoningRequest {
  const profile = reasoningProfileFor(providerId, modelId);
  if (!profile) return { kind: "unknown" };
  if (!profile.reasoning) return { kind: "none" };

  const values = normalizedEffortValues(profile.options);
  if (values.length > 0) {
    // An effort channel takes precedence over an accompanying toggle: it is strictly
    // more expressive, and sending both risks contradicting ourselves.
    const ceilingIndex = values.length - 1;
    const index = deepThinking ? ceilingIndex : Math.max(0, ceilingIndex - 1);
    return { kind: "effort", effort: values[index]! };
  }

  if (profile.options.some((o) => o.type === "budget_tokens")) {
    return { kind: "budget", effortHint: deepThinking ? "max" : "high" };
  }

  if (profile.options.some((o) => o.type === "toggle")) {
    // Genuinely two-state. There is no intermediate level to invent, so the headroom
    // rule does not apply here — inventing one is how MiniMax-M3 ended up receiving a
    // budget block it has no use for.
    return { kind: "toggle", enabled: deepThinking };
  }

  // reasoning: true with no declared control (e.g. MiniMax-M2.7, deepseek-reasoner) —
  // it reasons natively and takes no parameter. Sending one can only do harm.
  return { kind: "none" };
}

/**
 * Whether the model reasons at all, for UI gating. Undefined-safe: an unknown model
 * returns false here so the caller can fall back to its provider heuristic.
 */
export function catalogSaysReasons(
  providerId: string | undefined,
  modelId: string,
): boolean | undefined {
  const profile = reasoningProfileFor(providerId, modelId);
  return profile ? profile.reasoning : undefined;
}

/**
 * Whether the Deep-thinking toggle would actually change anything for this model.
 * A model that reasons natively with no control shows no toggle rather than a
 * control that silently does nothing.
 */
export function hasMeaningfulReasoningControl(
  providerId: string | undefined,
  modelId: string,
): boolean {
  const profile = reasoningProfileFor(providerId, modelId);
  if (!profile?.reasoning) return false;
  return (
    normalizedEffortValues(profile.options).length > 0 ||
    profile.options.some((o) => o.type === "budget_tokens" || o.type === "toggle")
  );
}

/** Test-only: clear both registries. */
export function __resetReasoningRegistryForTests(): void {
  profileById.clear();
  temperatureById.clear();
}
