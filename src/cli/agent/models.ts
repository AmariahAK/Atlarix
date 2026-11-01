/**
 * What `/model` offers: the same list as the desktop's model picker
 * (getLanguageModelsByProviders: Atlarix Auto and Core, then every provider
 * with models), arranged the way opencode's picker is — favourites, recent,
 * then providers — and filtered by what is typed.
 *
 * The CLI's choice, its recents and favourites live in ~/.atlarix/cli-state.json,
 * NOT the shared settings: picking a model in the terminal must not change the
 * desktop app's selected model.
 */
import fs from "node:fs";
import path from "node:path";
import { atlarixHomeDir } from "@/paths/atlarix-home";
import type { EffortChoices } from "@/lib/routing/model-reasoning-profile";
import type { ComputerUseEligibility } from "@/ipc/ipc_types";

export interface ModelRef {
  provider: string;
  name: string;
}

export interface ModelOption extends ModelRef {
  label: string;
  providerName: string;
  detail: string;
  deepThinking: boolean;
  /** What /effort offers on this model, exactly as it lists them (none: no control). */
  effortChoices?: EffortChoices;
  /** Costs nothing (Atlarix Auto): the picker's "Free" badge. */
  free?: boolean;
  /**
   * A paid Atlarix model (a Core slot or Zenith) on an account with no Pro and no
   * credit: the picker's muted "Credit" tag (owner, 2026-10-27). Never set for
   * an account that pays.
   */
  credit?: boolean;
  /** Whether computer use can be switched on for this model, or why not. */
  computerUse?: ComputerUseEligibility;
  /** "200K": the context window, for the picker's right column. */
  context?: string;
}

export interface ModelGroup {
  id: string;
  title: string;
  options: ModelOption[];
}

const COMPASS = "compass";

export async function loadModelOptions(): Promise<ModelOption[]> {
  const { getLanguageModelsByProviders, getLanguageModelProviders } = await import(
    "@/ipc/shared/language_model_helpers"
  );
  const [byProvider, providers] = await Promise.all([
    getLanguageModelsByProviders(),
    getLanguageModelProviders(),
  ]);
  const names = new Map(providers.map((p) => [p.id, p.name]));
  const { isCoreAutoTier, isCoreRouterTier } = await import("@/ipc/shared/compass_constants");
  // A provider switched off in an editor's Models & keys keeps its key but
  // offers no models here (the terminal and the editors).
  const off = await disabledProviders();
  const entries = Object.entries(byProvider).filter(([id, models]) => (models?.length ?? 0) > 0 && !off.has(id));
  // Auto is free only on a free account: Pro and credit pay for it, so it shows
  // its context size there, not "Free" (owner, 2026-10-18). Paid rows say
  // "Credit" to the same free account, and to nobody else.
  const kind = byProvider[COMPASS]?.length ? await accountKind() : "unknown";
  const paysForAuto = kind === "pro" || kind === "payg";
  entries.sort(([a], [b]) => (a === COMPASS ? -1 : b === COMPASS ? 1 : 0));
  const out: ModelOption[] = [];
  for (const [provider, models] of entries) {
    const providerName = provider === COMPASS ? "Atlarix" : (names.get(provider) ?? provider);
    for (const m of models) {
      // A Core row carries a cautious placeholder window; the meter shows the
      // model's real one, so the list reads the same (QA: "200K" here, "/1M" there).
      const window = provider === COMPASS ? await coreContextWindow(m.apiName, m.contextWindow) : m.contextWindow;
      const ctx = window ? `${formatWindow(window)} context` : "";
      const paidAuto = provider === COMPASS && isCoreAutoTier(m.apiName) && paysForAuto;
      out.push({
        provider,
        name: m.apiName,
        label: m.displayName || m.apiName,
        providerName,
        detail: [provider === COMPASS ? m.description : providerName, ctx].filter(Boolean).join(" · "),
        deepThinking: Boolean((m as { supportsDeepThinking?: boolean }).supportsDeepThinking),
        // Auto and Zenith pick the model per turn: no effort control (owner, 2026-10-29).
        effortChoices:
          provider === COMPASS && isCoreRouterTier(m.apiName) ? undefined : (m as { effortChoices?: EffortChoices }).effortChoices,
        computerUse: m.computerUse,
        free: provider === COMPASS && isCoreAutoTier(m.apiName) && !paidAuto,
        credit: provider === COMPASS && !isCoreAutoTier(m.apiName) && kind === "free",
        context: window ? `${formatWindow(window)}` : undefined,
      });
    }
  }
  return out;
}

/** The window the context meter uses for a Core row, else the row's own. */
async function coreContextWindow(name: string, listed: number | undefined): Promise<number | undefined> {
  try {
    const { getContextWindow } = await import("@/ipc/utils/token_utils");
    return (await getContextWindow({ provider: COMPASS, name } as never)) || listed;
  } catch {
    return listed;
  }
}

/** 200K, 1M: the meter's spelling. */
function formatWindow(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}K`;
}

/** Who pays for Core on the signed-in account; "unknown" when it can't be told. */
async function accountKind(): Promise<string> {
  try {
    const { realServices } = await import("./services");
    return (await realServices.account.kind?.()) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The models another session may set this user's sessions to (item 9): what
 * they can run. Atlarix Core and Auto need the account, so they are left out
 * while signed out, as the picker leaves them out (QA A10).
 */
export async function settableModelOptions(): Promise<ModelOption[]> {
  const options = await loadModelOptions();
  return (await hasCoreAccount()) ? options : options.filter((o) => o.provider !== COMPASS);
}

/** Signed in (or a cloud run's own Core token): what a Core turn is authorized with. */
async function hasCoreAccount(): Promise<boolean> {
  try {
    const { getPinnedCoreToken } = await import("@/ipc/shared/core_proxy");
    if (getPinnedCoreToken()) return true;
    const { getSession } = await import("@/lib/auth/supabase-client");
    return Boolean((await getSession())?.access_token);
  } catch {
    return false;
  }
}

/**
 * The model a turn runs on: the Plan model while planning, when one is set,
 * else the chosen one (undefined: the desktop's selected model).
 */
export function turnModelFor<T extends ModelRef>(mode: string, chosen: T | undefined, planModel: ModelRef | undefined): T | ModelRef | undefined {
  return mode === "plan" && planModel ? planModel : chosen;
}

/** Providers switched off (`providerSettings[id].enabled === false`). */
export async function disabledProviders(): Promise<Set<string>> {
  try {
    const { readSettings } = await import("@/main/settings");
    const ps = (readSettings() as { providerSettings?: Record<string, { enabled?: boolean }> }).providerSettings ?? {};
    return new Set(Object.entries(ps).filter(([, v]) => v?.enabled === false).map(([id]) => id));
  } catch {
    return new Set();
  }
}

const same = (a: ModelRef, b: ModelRef) => a.provider === b.provider && a.name === b.name;

/** The picker's sections for an empty search, opencode's order. */
export function groupOptions(
  options: ModelOption[],
  state: { favorites: ModelRef[]; recent: ModelRef[] },
): ModelGroup[] {
  const pick = (refs: ModelRef[]) =>
    refs.map((r) => options.find((o) => same(o, r))).filter((o): o is ModelOption => Boolean(o));
  const groups: ModelGroup[] = [];
  const fav = pick(state.favorites);
  if (fav.length) groups.push({ id: "favorites", title: "Favourites", options: fav });
  const recent = pick(state.recent).filter((o) => !fav.some((f) => same(f, o))).slice(0, 5);
  if (recent.length) groups.push({ id: "recent", title: "Recent", options: recent });
  // Each model once (opencode): one already under Favourites or Recent isn't
  // repeated under its provider.
  const shown = [...fav, ...recent];
  const byProvider = new Map<string, ModelOption[]>();
  for (const o of options) {
    if (shown.some((x) => same(x, o))) continue;
    byProvider.set(o.provider, [...(byProvider.get(o.provider) ?? []), o]);
  }
  for (const [id, opts] of byProvider) {
    groups.push({ id, title: opts[0]!.providerName, options: opts });
  }
  return groups;
}

/** Typed search: one flat list, names that START with the query first. */
export function filterOptions(options: ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  const hay = (o: ModelOption) => `${o.label} ${o.name} ${o.providerName}`.toLowerCase();
  const hits = options.filter((o) => q.split(/\s+/).every((w) => hay(o).includes(w)));
  return [
    ...hits.filter((o) => o.label.toLowerCase().startsWith(q)),
    ...hits.filter((o) => !o.label.toLowerCase().startsWith(q)),
  ];
}

// ─── the CLI's own memory ────────────────────────────────────────────────────

export interface CliState {
  model?: ModelRef;
  recent: ModelRef[];
  favorites: ModelRef[];
  /** On when the top of the model's /effort list is chosen (kept for older builds). */
  deepThinking?: boolean;
  /** /effort: the level, exactly as the model lists it; empty is its default. */
  effort?: string;
  /** Terminal notifications when a turn ends or needs you (on unless turned off). */
  notifications?: boolean;
  /** A different model while planning (Plan mode); the chosen model builds. Off when unset. */
  planModel?: ModelRef;
  /** Chats starred in an editor's Past chats, newest first. */
  starredSessions?: string[];
  /**
   * The header's name for `model`, remembered so the terminal draws at once
   * instead of loading every provider's model list first (1.7–2.1s measured
   * 2026-10-17). Keyed by the model it names, so a model chosen elsewhere (an
   * editor) never borrows another's label.
   */
  modelLabel?: ModelRef & { label: string };
}

/** ~/.atlarix/cli-state.json (a scratch profile's own: atlarixHomeDir); ATLARIX_CLI_STATE_FILE names it outright. */
function statePath(): string {
  return process.env.ATLARIX_CLI_STATE_FILE || path.join(atlarixHomeDir(), "cli-state.json");
}

export function readCliState(file = statePath()): CliState {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CliState>;
    return {
      recent: s.recent ?? [],
      favorites: s.favorites ?? [],
      model: s.model,
      deepThinking: s.deepThinking,
      effort: typeof s.effort === "string" ? s.effort : undefined,
      notifications: s.notifications,
      planModel: s.planModel && typeof s.planModel.provider === "string" && typeof s.planModel.name === "string" ? s.planModel : undefined,
      starredSessions: Array.isArray(s.starredSessions) ? s.starredSessions.filter((x): x is string => typeof x === "string") : undefined,
      modelLabel:
        s.modelLabel && typeof s.modelLabel.provider === "string" && typeof s.modelLabel.name === "string" && typeof s.modelLabel.label === "string"
          ? s.modelLabel
          : undefined,
    };
  } catch {
    return { recent: [], favorites: [] };
  }
}

export function writeCliState(next: CliState, file = statePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
}

/** The remembered header label for the chosen model, or its plain name. */
export function savedModelLabel(state: CliState): string | undefined {
  const m = state.model;
  if (!m) return undefined;
  const l = state.modelLabel;
  return l && same(l, m) ? l.label : m.name;
}

/** Choosing a model: it becomes the CLI's model and the most recent. */
export function rememberChoice(state: CliState, ref: ModelRef): CliState {
  return {
    ...state,
    model: ref,
    recent: [ref, ...state.recent.filter((r) => !same(r, ref))].slice(0, 10),
  };
}

export function toggleFavorite(state: CliState, ref: ModelRef): CliState {
  const has = state.favorites.some((f) => same(f, ref));
  return { ...state, favorites: has ? state.favorites.filter((f) => !same(f, ref)) : [...state.favorites, ref] };
}

/**
 * The model as the header names it: a custom provider's with that provider's
 * name, since the same model may come from several ("qwen2.5:3b · Your key"
 * three times over, QA).
 */
export function headerModelLabel(o: { provider: string; label: string; providerName: string }): string {
  return o.provider.startsWith("custom::") ? `${o.label} (${o.providerName})` : o.label;
}

