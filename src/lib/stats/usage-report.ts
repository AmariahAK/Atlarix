/**
 * The Usage page's data, the same on every surface (app, CLI, VS Code, ACP):
 * the overview ("Your activity"), tokens per day stacked by model, MCP and skill
 * calls per day, the models Atlarix Auto answered with, and a BYOK estimate.
 *
 * Everything here is LOCAL: the rollups on this computer (usage-stats). Atlarix
 * credits are the account's and come separately (billing/usage-credits).
 */

import { db } from "@/db";
import { usageAutoPicks, usageToolStats } from "@/db/schema";
import { getCoreAuto } from "@/ipc/shared/core-model-override-store";
import { formatModelApiNameForDisplay } from "@/lib/format-openrouter-model-label";
import { localDayString } from "./edit-stats-calendar";
import { USAGE_RANGES, type UsageRange } from "./usage-format";
import {
  usageModelLabel,
  usageSourceLabel,
  usageSurfaceKey,
  usageSurfaceLabel,
} from "./usage-labels";
import {
  getActivityStats,
  usageRows,
  type UsageRollupRow,
} from "./usage-stats";
import type { ActivityStats } from "./usage-types";

export { USAGE_RANGES, type UsageRange } from "./usage-format";

export type { UsageFilters, UsageOption, UsageReport } from "./usage-types";
import type { UsageFilters, UsageOption, UsageReport } from "./usage-types";

const SERIES = 5;

/** The last `n` local days ending today, oldest first. */
export function windowDays(n: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(
      localDayString(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - i),
      ),
    );
  }
  return out;
}

const modelKey = (r: { provider: string; modelId: string }) =>
  `${r.provider}\u0000${r.modelId}`;

const shareOf = (n: number, total: number) =>
  total > 0 ? Math.round((n / total) * 1000) / 10 : 0;

/** How an Auto pick reads: its name only when Auto's own config lists it (never a gateway). */
export function autoPickLabel(
  servedModel: string,
  billing: string,
  nameable: ReadonlySet<string>,
): string {
  if (nameable.has(servedModel))
    return formatModelApiNameForDisplay(servedModel);
  return billing === "free" ? "Other free models" : "Other models";
}

/** Tokens, filters and the BYOK estimate from rollup rows (pure, for tests). */
export function buildUsageReport(
  overview: ActivityStats,
  rows: readonly UsageRollupRow[],
  tools: ReadonlyArray<{
    day: string;
    kind: string;
    name: string;
    runs: number;
  }>,
  picks: ReadonlyArray<{
    day: string;
    billing: string;
    tier: string;
    servedModel: string;
    steps: number;
  }>,
  filters: UsageFilters,
  now: Date,
  nameable: ReadonlySet<string> = new Set(),
): UsageReport {
  const range = USAGE_RANGES.includes(filters.days as UsageRange)
    ? (filters.days as number)
    : 30;
  const days = windowDays(range, now);
  const first = days[0]!;
  const inWindow = (d: string) => d >= first && d <= days[days.length - 1]!;

  // Filter options come from every row, so a filter never hides its own choices.
  const models = new Map<string, { label: string; tokens: number }>();
  const surfaces = new Map<string, number>();
  const sources = new Map<string, number>();
  for (const r of rows) {
    const t = r.inputTokens + r.outputTokens;
    const k = modelKey(r);
    const m = models.get(k) ?? {
      label: usageModelLabel(r, overview.providerNames),
      tokens: 0,
    };
    m.tokens += t;
    models.set(k, m);
    const sk = usageSurfaceKey(r);
    surfaces.set(sk, (surfaces.get(sk) ?? 0) + t);
    sources.set(r.source, (sources.get(r.source) ?? 0) + t);
  }
  const applied = {
    model: filters.model && models.has(filters.model) ? filters.model : null,
    surface:
      filters.surface && surfaces.has(filters.surface) ? filters.surface : null,
    source:
      filters.source && sources.has(filters.source) ? filters.source : null,
  };
  const kept = rows.filter(
    (r) =>
      (!applied.model || modelKey(r) === applied.model) &&
      (!applied.surface || usageSurfaceKey(r) === applied.surface) &&
      (!applied.source || r.source === applied.source),
  );

  // Series: the window's five biggest models, then the rest as one.
  const windowByModel = new Map<string, number>();
  for (const r of kept) {
    if (!inWindow(r.day)) continue;
    windowByModel.set(
      modelKey(r),
      (windowByModel.get(modelKey(r)) ?? 0) + r.inputTokens + r.outputTokens,
    );
  }
  const ranked = [...windowByModel]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, SERIES).map(([k]) => k);
  const hasOther = ranked.length > SERIES;
  const series: UsageOption[] = [
    ...top.map((k) => ({ key: k, label: models.get(k)!.label })),
    ...(hasOther ? [{ key: "other", label: "Other" }] : []),
  ];
  const index = new Map(top.map((k, i) => [k, i]));
  const byDayTokens = new Map(
    days.map((d) => [d, new Array<number>(series.length).fill(0)]),
  );
  let total = 0;
  for (const r of kept) {
    const v = byDayTokens.get(r.day);
    if (!v) continue;
    const t = r.inputTokens + r.outputTokens;
    if (t <= 0) continue;
    v[index.get(modelKey(r)) ?? series.length - 1] += t;
    total += t;
  }
  const tokenDays = rows
    .filter((r) => r.inputTokens + r.outputTokens > 0)
    .map((r) => r.day)
    .sort();

  // MCP and skills per day.
  const toolDays = new Map(days.map((d) => [d, { day: d, mcp: 0, skill: 0 }]));
  const runsBy = {
    mcp: new Map<string, number>(),
    skill: new Map<string, number>(),
  };
  for (const t of tools) {
    if (t.kind !== "mcp" && t.kind !== "skill") continue;
    const d = toolDays.get(t.day);
    if (d) d[t.kind] += t.runs;
    if (inWindow(t.day))
      runsBy[t.kind].set(t.name, (runsBy[t.kind].get(t.name) ?? 0) + t.runs);
  }
  const topRuns = (m: Map<string, number>) =>
    [...m]
      .map(([name, runs]) => ({ name, runs }))
      .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
      .slice(0, 10);

  // Auto picks in the window.
  const pickBy = new Map<
    string,
    { label: string; billing: "free" | "paid"; tier: string; steps: number }
  >();
  const pickDays = new Map(days.map((d) => [d, { day: d, free: 0, paid: 0 }]));
  let pickSteps = 0;
  for (const p of picks) {
    if (!inWindow(p.day)) continue;
    const billing = p.billing === "paid" ? "paid" : "free";
    const label = autoPickLabel(p.servedModel, billing, nameable);
    const key = `${billing}\u0000${p.tier}\u0000${label}`;
    const e = pickBy.get(key) ?? { label, billing, tier: p.tier, steps: 0 };
    e.steps += p.steps;
    pickBy.set(key, e);
    pickDays.get(p.day)![billing] += p.steps;
    pickSteps += p.steps;
  }

  // BYOK estimate: only rows that carry one.
  const byokDays = new Map(days.map((d) => [d, 0]));
  let micros = 0;
  let priced = 0;
  let unpriced = 0;
  let byokSince: string | null = null;
  for (const r of kept) {
    if (r.pricedTurns + r.unpricedTurns === 0) continue;
    if (!byokSince || r.day < byokSince) byokSince = r.day;
    if (!inWindow(r.day)) continue;
    priced += r.pricedTurns;
    unpriced += r.unpricedTurns;
    micros += r.estCostMicros;
    byokDays.set(r.day, (byokDays.get(r.day) ?? 0) + r.estCostMicros);
  }

  return {
    overview,
    range,
    days,
    filters: {
      models: [...models]
        .sort((a, b) => b[1].tokens - a[1].tokens)
        .map(([key, m]) => ({ key, label: m.label })),
      surfaces: [...surfaces]
        .sort((a, b) => b[1] - a[1])
        .map(([key]) => ({ key, label: usageSurfaceLabel(key) })),
      sources: [...sources]
        .sort((a, b) => b[1] - a[1])
        .map(([key]) => ({ key, label: usageSourceLabel(key) })),
      applied,
    },
    tokens: {
      series,
      byDay: days.map((day) => ({ day, values: byDayTokens.get(day)! })),
      total,
      since: tokenDays[0] ?? null,
    },
    tools: {
      byDay: [...toolDays.values()],
      mcp: topRuns(runsBy.mcp),
      skills: topRuns(runsBy.skill),
    },
    autoPicks: {
      steps: pickSteps,
      models: [...pickBy.values()]
        .sort((a, b) => b.steps - a.steps)
        .map((e) => ({ ...e, share: shareOf(e.steps, pickSteps) })),
      byDay: [...pickDays.values()],
      since: picks.length
        ? picks.reduce((m, p) => (p.day < m ? p.day : m), picks[0]!.day)
        : null,
    },
    byok:
      priced > 0 && byokSince
        ? {
            totalUsd: micros / 1e6,
            byDay: days.map((day) => ({
              day,
              usd: (byokDays.get(day) ?? 0) / 1e6,
            })),
            pricedTurns: priced,
            unpricedTurns: unpriced,
            since: byokSince,
          }
        : null,
  };
}

export async function getUsageReport(
  filters: UsageFilters = {},
  now: Date = new Date(),
): Promise<UsageReport> {
  const [overview, rows, tools, picks] = await Promise.all([
    getActivityStats(now),
    usageRows(),
    db.select().from(usageToolStats),
    db.select().from(usageAutoPicks),
  ]);
  return buildUsageReport(
    overview,
    rows,
    tools,
    picks,
    filters,
    now,
    new Set(getCoreAuto()?.nameableModels ?? []),
  );
}
