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
/**
 * Effort values PROVED for a model where the catalog is wrong (core-models.json
 * `modelEfforts`, by bare model id). GLM-5.3 rejects `medium` with error 1210
 * though nothing in the catalog says so.
 */
const effortOverrides = new Map<string, string[]>();

/** Replace the proved effort lists (on every core-models.json load). */
export function registerEffortOverrides(map: Record<string, string[]>): void {
  effortOverrides.clear();
  for (const [id, values] of Object.entries(map)) {
    if (Array.isArray(values) && values.length) effortOverrides.set(id.toLowerCase(), values.map(String));
  }
}

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
    // The bare id is settled below, from every row in this batch.
    if (!temperatureById.has(bare))
      temperatureById.set(bare, e.supportsTemperature);
  }
  // Bare id too — callers pass ids with or without a vendor prefix (a custom
  // gateway serving gpt-5.4). What MOST rows say, never the first or the longest:
  // an aggregator listed first hid gpt-5.4's none…xhigh (QA N1), and gateways that
  // pad their lists would have offered MiniMax-M3 five levels it doesn't take
  // (QA N6). "No control" counts as an answer; a tie goes to the shorter list.
  const byBare = new Map<string, ModelReasoningProfile[]>();
  for (const e of entries) {
    const bare = e.modelId.toLowerCase();
    byBare.set(bare, [...(byBare.get(bare) ?? []), e.profile]);
  }
  for (const [bare, rows] of byBare) profileById.set(bare, consensusProfile(rows));
}

/** The profile most rows agree on; a tie goes to the one listing fewer values. */
function consensusProfile(rows: ModelReasoningProfile[]): ModelReasoningProfile {
  const sig = (p: ModelReasoningProfile) =>
    JSON.stringify([p.reasoning, p.options.map((o) => [o.type, o.values ?? []]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  const size = (p: ModelReasoningProfile) => p.options.reduce((n, o) => n + 1 + (o.values?.length ?? 0), 0);
  const counts = new Map<string, { n: number; p: ModelReasoningProfile }>();
  for (const p of rows) {
    const k = sig(p);
    counts.set(k, { n: (counts.get(k)?.n ?? 0) + 1, p });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || size(a.p) - size(b.p))[0]!.p;
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
  if (openAiDropsTemperature(providerId, modelId)) return false;
  return catalogAllowsTemperature(providerId, modelId);
}

/**
 * The catalog's word alone. Atlarix Core uses this: its requests go to our proxy,
 * which drops `temperature` for OpenAI Responses itself and passes it to Z.ai, so
 * the OpenAI SDK rule above does not apply to it.
 */
export function catalogAllowsTemperature(
  providerId: string | undefined,
  modelId: string,
): boolean {
  return lookup(temperatureById, providerId, modelId) ?? true;
}

/**
 * The OpenAI SDK's own rule (`getOpenAILanguageModelCapabilities` in
 * @ai-sdk/openai): o-series and gpt-5+ models other than the dated `-chat`
 * variants are reasoning models, and it strips `temperature` from them with an
 * "unsupported" warning that the CLI used to show as a toast. Not sending it is
 * the same request without the warning.
 */
function openAiDropsTemperature(
  providerId: string | undefined,
  modelId: string,
): boolean {
  if (providerId !== "openai" && providerId !== "azure") return false;
  const id = modelId.toLowerCase().replace(/^openai\//, "");
  if (/^o\d+(?:-|$)/.test(id)) return true;
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(id);
  if (!gpt) return false;
  const isChat = gpt[2] == null && (gpt[3] ?? "").startsWith("chat");
  return Number(gpt[1]) >= 5 && !isChat;
}

// ── Effort resolution ────────────────────────────────────────────────────────

function normalizeEffort(value: string): EffortLevel | null {
  const v = value.trim().toLowerCase();
  if (v === "xhigh" || v === "x-high" || v === "very-high") return "max";
  return (EFFORT_ORDER as readonly string[]).includes(v)
    ? (v as EffortLevel)
    : null;
}

/** Model-declared effort values, normalized, deduped, in canonical order. */
export function normalizedEffortValues(
  options: ReasoningOption[],
): EffortLevel[] {
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
 * What `/effort` offers for a model, EXACTLY as the model lists it (owner,
 * 2026-10-17: "we dont normalize, can we just show it as they come"): `xhigh`
 * stays `xhigh`, `none` and `minimal` stay. Only models that publish no names get
 * names made up: three budget sizes, or off / on.
 *
 * `defaultLevel` is what runs when nothing was chosen; it matches what the model
 * got before /effort existed (one below the top of its list).
 */
export type EffortChoices = {
  kind: "effort" | "budget" | "toggle";
  levels: string[];
  defaultLevel: string;
};

/** Budget sizes for a budget-only model, small to large, and the share each asks for. */
export const BUDGET_LEVELS = ["low", "medium", "high"] as const;
// `medium` is the default, so it asks for what an unset level does; `low` asks
// for less. It used to be low → medium, medium → high: low then equalled the
// default and choosing medium gave more than it (QA, 15.8.0).
const BUDGET_HINT: Record<string, "low" | "medium" | "max"> = { low: "low", medium: "medium", high: "max" };

/** Values that turn reasoning off, never a default. */
const NO_REASONING = new Set(["none", "minimal"]);

/** A model's own effort values, trimmed and de-duplicated, in the catalog's order. */
export function rawEffortValues(options: ReasoningOption[]): string[] {
  const effort = options.find((o) => o.type === "effort");
  if (!effort || !Array.isArray(effort.values)) return [];
  const out: string[] = [];
  for (const raw of effort.values) {
    const v = String(raw).trim();
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

function defaultOf(levels: string[]): string {
  const reasoning = levels.filter((l) => !NO_REASONING.has(l.toLowerCase()));
  const pool = reasoning.length ? reasoning : levels;
  return pool[Math.max(0, pool.length - 2)]!;
}

/** The /effort choices for a model, or null when it has none (or isn't known). */
function overrideFor(modelId: string): string[] | undefined {
  if (!modelId) return undefined;
  const id = modelId.toLowerCase();
  return effortOverrides.get(id) ?? effortOverrides.get(id.split("/").pop()!);
}

/**
 * OpenAI's own routes (BYOK OpenAI, Azure, and Core models OpenAI serves) have
 * always run `medium` when nothing was chosen (`openAiReasoningEffort`), not one
 * below the top: the default marked in /effort must be what actually runs.
 */
function defaultFor(providerId: string | undefined, levels: string[]): string {
  const p = providerId?.toLowerCase();
  if ((p === "openai" || p === "azure") && levels.includes("medium")) return "medium";
  return defaultOf(levels);
}

export function effortChoicesFor(providerId: string | undefined, modelId: string): EffortChoices | null {
  const override = overrideFor(modelId);
  if (override) return { kind: "effort", levels: override, defaultLevel: defaultFor(providerId, override) };
  const profile = reasoningProfileFor(providerId, modelId);
  if (!profile?.reasoning) return null;
  const values = rawEffortValues(profile.options);
  if (values.length) return { kind: "effort", levels: values, defaultLevel: defaultFor(providerId, values) };
  if (profile.options.some((o) => o.type === "budget_tokens")) return { kind: "budget", levels: [...BUDGET_LEVELS], defaultLevel: "medium" };
  if (profile.options.some((o) => o.type === "toggle")) return { kind: "toggle", levels: ["off", "on"], defaultLevel: "off" };
  return null;
}

/**
 * Paid Atlarix Auto's levels. They choose WHICH models run (the proxy's lane
 * table), not one model's effort: low = the small models at high reasoning,
 * medium = the default lanes, max = what deep thinking was (owner, 2026-10-17).
 * Free Auto has none.
 */
export const AUTO_EFFORT_LEVELS = ["low", "medium", "max"] as const;
export type AutoEffort = (typeof AUTO_EFFORT_LEVELS)[number];

/** The /effort choices for paid Auto. */
export const AUTO_EFFORT_CHOICES: EffortChoices = { kind: "effort", levels: [...AUTO_EFFORT_LEVELS], defaultLevel: "medium" };

/** The Auto level a request carries (`X-Atlarix-Effort`). */
export function autoEffort(settings: { effort?: string; deepThinking?: boolean } | undefined): AutoEffort {
  return chosenLevel(AUTO_EFFORT_CHOICES, settings?.effort, !!settings?.deepThinking) as AutoEffort;
}

/** The top of a model's list: what deep thinking and ctrl+t ask for. */
export function topLevel(choices: EffortChoices): string {
  return choices.levels.at(-1)!;
}

/**
 * The level that runs: the chosen one when this model lists it (any case), else
 * the top for the old deep-thinking switch, else the default. A level another
 * model had is never translated (owner: changing model resets it).
 */
export function chosenLevel(choices: EffortChoices, effort: string | undefined, deepThinking = false): string {
  const want = effort?.trim().toLowerCase();
  const hit = want ? choices.levels.find((l) => l.toLowerCase() === want) : undefined;
  if (hit) return hit;
  return deepThinking ? topLevel(choices) : choices.defaultLevel;
}

/**
 * The settings a choice writes, from every surface (app, CLI, editor): the level,
 * and the old deep-thinking switch kept in step with "the top is chosen", so the
 * routes that still read it (a model the catalog doesn't know, an older proxy)
 * keep doing the right thing.
 */
export function effortSettingsPatch(choices: EffortChoices, level: string): { effort: string; deepThinking: boolean } {
  const hit = choices.levels.find((l) => l.toLowerCase() === level.trim().toLowerCase()) ?? choices.defaultLevel;
  // The default is stored as unset, so it follows each model's own default
  // after a model change instead of sticking as an explicit level (QA R1).
  if (hit === choices.defaultLevel) return { effort: "", deepThinking: false };
  return { effort: hit, deepThinking: hit === topLevel(choices) };
}

/**
 * After the model changes: keep the level when the new model lists it too,
 * otherwise go back to that model's default. Never translated (owner).
 */
export function effortAfterModelChange(
  choices: EffortChoices | null,
  settings: { effort?: string; deepThinking?: boolean },
): { effort: string; deepThinking: boolean } {
  if (!choices) return { effort: "", deepThinking: false };
  // Nothing chosen: nothing to keep. The new model runs its own default (QA R1).
  if (!settings.effort?.trim() && !settings.deepThinking) return { effort: "", deepThinking: false };
  const current = chosenLevel(choices, settings.effort, !!settings.deepThinking && !settings.effort);
  const listed = settings.effort ? choices.levels.some((l) => l.toLowerCase() === settings.effort!.trim().toLowerCase()) : true;
  return listed ? effortSettingsPatch(choices, current) : { effort: "", deepThinking: false };
}

/** A level that turns reasoning off: `none` / `minimal` as listed, or off / on's `off`. */
export function isReasoningOff(choices: EffortChoices, level: string): boolean {
  const l = level.toLowerCase();
  return NO_REASONING.has(l) || (choices.kind === "toggle" && l === "off");
}

/**
 * A chosen level's place on the old four-step scale, for routes that take a token
 * budget rather than a named level (Anthropic, OpenRouter): by its position in the
 * model's own list, so the top always asks for the most.
 */
export function levelShare(choices: EffortChoices, level: string): "low" | "medium" | "high" | "xhigh" | "max" {
  if (choices.kind === "budget") return BUDGET_HINT[level] ?? "high";
  const reasoning = choices.levels.filter((l) => !NO_REASONING.has(l.toLowerCase()));
  const i = reasoning.findIndex((l) => l.toLowerCase() === level.toLowerCase());
  if (i < 0) return "medium";
  const steps = ["medium", "high", "xhigh", "max"] as const;
  if (reasoning.length === 1) return "max";
  return steps[Math.round((i / (reasoning.length - 1)) * (steps.length - 1))]!;
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
  | { kind: "effort"; effort: string }
  | { kind: "budget"; effortHint: "low" | "medium" | "high" | "xhigh" | "max" }
  | { kind: "unknown" };

export type ResolveReasoningArgs = {
  providerId: string | undefined;
  modelId: string;
  /** The user's Deep-thinking toggle. */
  deepThinking: boolean;
  /** The level chosen with /effort; unset keeps the behaviour from before it. */
  effort?: string;
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
  effort,
}: ResolveReasoningArgs): ReasoningRequest {
  // A level chosen with /effort that this model lists goes out exactly as listed.
  if (effort?.trim()) {
    const choices = effortChoicesFor(providerId, modelId);
    const want = effort.trim().toLowerCase();
    if (choices?.levels.some((l) => l.toLowerCase() === want)) {
      const level = chosenLevel(choices, effort);
      if (choices.kind === "effort") return { kind: "effort", effort: level };
      if (choices.kind === "toggle") return { kind: "toggle", enabled: level === "on" };
      return { kind: "budget", effortHint: levelShare(choices, level) };
    }
  }
  const override = overrideFor(modelId);
  if (override) {
    const choices = { kind: "effort" as const, levels: override, defaultLevel: defaultOf(override) };
    return { kind: "effort", effort: chosenLevel(choices, undefined, deepThinking) };
  }
  const profile = reasoningProfileFor(providerId, modelId);
  if (!profile) return { kind: "unknown" };
  if (!profile.reasoning) return { kind: "none" };

  const values = rawEffortValues(profile.options);
  if (values.length > 0) {
    // An effort channel takes precedence over an accompanying toggle: it is strictly
    // more expressive, and sending both risks contradicting ourselves. The model's
    // OWN values, as listed: a normalized ladder sent gpt-5.4 "max", which it
    // doesn't list (QA R5).
    const choices = { kind: "effort" as const, levels: values, defaultLevel: defaultFor(providerId, values) };
    return { kind: "effort", effort: chosenLevel(choices, undefined, deepThinking) };
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
    profile.options.some(
      (o) => o.type === "budget_tokens" || o.type === "toggle",
    )
  );
}

/** Test-only: clear the registries. */
export function __resetReasoningRegistryForTests(): void {
  profileById.clear();
  temperatureById.clear();
  effortOverrides.clear();
}
