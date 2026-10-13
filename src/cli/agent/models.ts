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
import os from "node:os";
import path from "node:path";

export interface ModelRef {
  provider: string;
  name: string;
}

export interface ModelOption extends ModelRef {
  label: string;
  providerName: string;
  detail: string;
  deepThinking: boolean;
  /** Costs nothing (Atlarix Auto): the picker's "Free" badge. */
  free?: boolean;
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
  const { isCoreAutoTier } = await import("@/ipc/shared/compass_constants");
  // A provider switched off in an editor's Models & keys keeps its key but
  // offers no models here (the terminal and the editors).
  const off = await disabledProviders();
  const entries = Object.entries(byProvider).filter(([id, models]) => (models?.length ?? 0) > 0 && !off.has(id));
  entries.sort(([a], [b]) => (a === COMPASS ? -1 : b === COMPASS ? 1 : 0));
  const out: ModelOption[] = [];
  for (const [provider, models] of entries) {
    const providerName = provider === COMPASS ? "Atlarix" : (names.get(provider) ?? provider);
    for (const m of models) {
      const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : "";
      out.push({
        provider,
        name: m.apiName,
        label: m.displayName || m.apiName,
        providerName,
        detail: [provider === COMPASS ? m.description : providerName, ctx].filter(Boolean).join(" · "),
        deepThinking: Boolean((m as { supportsDeepThinking?: boolean }).supportsDeepThinking),
        free: provider === COMPASS && isCoreAutoTier(m.apiName),
        context: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : undefined,
      });
    }
  }
  return out;
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
  deepThinking?: boolean;
  /** Terminal notifications when a turn ends or needs you (on unless turned off). */
  notifications?: boolean;
  /** When the session rating was last answered or dismissed (session-rating.ts). */
  ratedAt?: number;
  /** A different model while planning (Plan mode); the chosen model builds. Off when unset. */
  planModel?: ModelRef;
  /** Chats starred in an editor's Past chats, newest first. */
  starredSessions?: string[];
}

function statePath(): string {
  return path.join(os.homedir(), ".atlarix", "cli-state.json");
}

export function readCliState(file = statePath()): CliState {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CliState>;
    return {
      recent: s.recent ?? [],
      favorites: s.favorites ?? [],
      model: s.model,
      deepThinking: s.deepThinking,
      notifications: s.notifications,
      ratedAt: typeof s.ratedAt === "number" ? s.ratedAt : undefined,
      planModel: s.planModel && typeof s.planModel.provider === "string" && typeof s.planModel.name === "string" ? s.planModel : undefined,
      starredSessions: Array.isArray(s.starredSessions) ? s.starredSessions.filter((x): x is string => typeof x === "string") : undefined,
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

