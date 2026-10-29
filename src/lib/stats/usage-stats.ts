/**
 * Your activity: the agent's turns on this computer, for the Usage page every
 * surface shows (app, CLI, VS Code, ACP).
 *
 * WHAT IS RECORDED. One upsert per turn into the daily rollups (`usage_rollup`,
 * `usage_tool_stats`): the surface and editor, the model as DISPATCHED (via the
 * same resolution as edit stats), the work mode, deep thinking, tokens with the
 * cache split, a BYOK list-price estimate, the turn's sub-agent and compaction
 * tokens, and which skills and MCP servers it used. A stopped or failed turn adds
 * its tokens but is not counted as a turn. Atlarix Auto replies add the model
 * that answered (`usage_auto_picks`). No prompt text, no file paths. Local to
 * this computer: the app, CLI and editors share the one database.
 *
 * `usage_stats` (before 0082) is still read, never written: older builds sharing
 * this file keep writing it, and their turns count too.
 *
 * WHAT IS DERIVED. Days and chats older than the rollup come from the chat
 * history itself (one user message = one turn), so the calendar, streaks and
 * longest chat are right from the first day of this release; tokens, models and
 * tools only count from then ("since" says when).
 */

import log from "electron-log";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  usageAutoPicks,
  usageRollup,
  usageStats,
  usageToolStats,
} from "@/db/schema";
import { localDayKey } from "./edit-stats";
import type { ActivityDay, ActivityStats } from "./usage-types";
import { printableName } from "./usage-labels";
import {
  bucketThresholds,
  levelFor,
  localDayString,
  parseLocalDay,
} from "./edit-stats-calendar";

const logger = log.scope("usage-stats");

export type { ActivitySurface } from "./usage-types";
import type { ActivitySurface } from "./usage-types";

/** Which surface this process is: the CLI sets ATLARIX_SURFACE, ACP/VS Code also ATLARIX_PEER_SURFACE. */
export function currentSurface(): ActivitySurface {
  if (process.env.ATLARIX_PEER_SURFACE === "editor") return "editor";
  return process.env.ATLARIX_SURFACE === "cli" ? "cli" : "app";
}

// ─── Recording ──────────────────────────────────────────────────────────────

/** A skill's name from the path a turn read it at, or null. */
export function skillFromPath(p: string): string | null {
  const project =
    /(?:^|[\\/])\.atlarix[\\/]skills[\\/](?:.*[\\/])?([^\\/]+?)\.md$/i.exec(p);
  return project ? project[1]! : null;
}

/** Skill reads and MCP calls in a turn's native messages, counted. */
export function toolRunsFrom(messages: readonly unknown[]): {
  skills: Map<string, number>;
  mcp: Map<string, number>;
} {
  const skills = new Map<string, number>();
  const mcp = new Map<string, number>();
  const bump = (m: Map<string, number>, raw: string) => {
    const k = printableName(raw);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (const msg of messages) {
    const content = (msg as { role?: unknown; content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as {
        type?: unknown;
        toolName?: unknown;
        input?: unknown;
        args?: unknown;
      };
      if (p?.type !== "tool-call" || typeof p.toolName !== "string") continue;
      const input = (p.input ?? p.args ?? {}) as Record<string, unknown>;
      if (
        p.toolName === "mcp_call" &&
        typeof input.server === "string" &&
        input.server.trim()
      ) {
        bump(mcp, input.server.trim());
      } else if (p.toolName === "read_file" && typeof input.path === "string") {
        const skill = skillFromPath(input.path);
        if (skill) bump(skills, skill);
      }
    }
  }
  return { skills, mcp };
}

/** Where a rollup row's tokens came from. */
export type UsageSource =
  | "chat"
  | "automation"
  | "subagent"
  | "compaction"
  | "other";

/** A turn's auxiliary calls, grouped as `summarizeAuxBySource` does (measured tokens only). */
export interface AuxSpend {
  source: "subagent" | "compaction" | "other";
  inputTokens: number;
  outputTokens: number;
}

/** Group `takeAuxUsage`'s labels into rollup sources; estimated tokens are left out. */
export function auxSpendFrom(
  byLabel:
    | Readonly<
        Record<
          string,
          { tokens: number; inputTokens: number; outputTokens: number }
        >
      >
    | null
    | undefined,
): AuxSpend[] {
  const by = new Map<AuxSpend["source"], AuxSpend>();
  for (const [label, e] of Object.entries(byLabel ?? {})) {
    const source = label.startsWith("subagent")
      ? "subagent"
      : label.startsWith("compaction")
        ? "compaction"
        : "other";
    const split = e.inputTokens + e.outputTokens;
    // A provider that reported only a total: count it as input rather than drop it.
    const input = split > 0 ? e.inputTokens : Math.max(0, e.tokens);
    const output = split > 0 ? e.outputTokens : 0;
    if (input + output <= 0) continue;
    const a = by.get(source) ?? { source, inputTokens: 0, outputTokens: 0 };
    a.inputTokens += input;
    a.outputTokens += output;
    by.set(source, a);
  }
  return [...by.values()];
}

export interface TurnUsage {
  model: { provider: string; name: string } | null;
  mode: string;
  deep: boolean;
  /** False for a stopped or failed turn: its tokens count, the turn does not. */
  finished?: boolean;
  /** An automation's turn rather than one somebody typed. */
  automation?: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, read from / written to the provider's cache. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * BYOK only: the turn's list-price estimate in USD (reliable prices only), or
   * null when there is none. Undefined for Atlarix (Core/Auto), which is billed.
   */
  costUsd?: number | null;
  aux?: readonly AuxSpend[];
  messages: readonly unknown[];
  surface?: ActivitySurface;
  editor?: string;
  now?: Date;
}

const nonNeg = (n: number | undefined) =>
  Math.max(0, Math.round(Number.isFinite(n) ? (n as number) : 0));

/** The editor running this agent (ACP), normalised for grouping; '' outside one. */
export function currentEditor(): string {
  return printableName(process.env.ATLARIX_ACP_EDITOR ?? "", 40).toLowerCase();
}

async function addRow(row: {
  day: string;
  surface: string;
  editor: string;
  source: UsageSource;
  provider: string;
  modelId: string;
  mode: string;
  turns: number;
  deepTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostMicros: number;
  pricedTurns: number;
  unpricedTurns: number;
}): Promise<void> {
  const r = usageRollup;
  await db
    .insert(r)
    .values(row)
    .onConflictDoUpdate({
      target: [
        r.day,
        r.surface,
        r.editor,
        r.source,
        r.provider,
        r.modelId,
        r.mode,
      ],
      set: {
        turns: sql`${r.turns} + ${row.turns}`,
        deepTurns: sql`${r.deepTurns} + ${row.deepTurns}`,
        inputTokens: sql`${r.inputTokens} + ${row.inputTokens}`,
        outputTokens: sql`${r.outputTokens} + ${row.outputTokens}`,
        cacheReadTokens: sql`${r.cacheReadTokens} + ${row.cacheReadTokens}`,
        cacheWriteTokens: sql`${r.cacheWriteTokens} + ${row.cacheWriteTokens}`,
        estCostMicros: sql`${r.estCostMicros} + ${row.estCostMicros}`,
        pricedTurns: sql`${r.pricedTurns} + ${row.pricedTurns}`,
        unpricedTurns: sql`${r.unpricedTurns} + ${row.unpricedTurns}`,
      },
    });
}

export async function recordTurnUsage(u: TurnUsage): Promise<void> {
  const day = localDayKey(u.now ?? new Date());
  const finished = u.finished !== false;
  const base = {
    day,
    surface: u.surface ?? currentSurface(),
    editor: u.editor ?? currentEditor(),
    provider: u.model?.provider ?? "unknown",
    modelId: u.model?.name ?? "unknown",
    mode: u.mode || "build",
  };
  const tokensIn = nonNeg(u.inputTokens);
  const tokensOut = nonNeg(u.outputTokens);
  const priced = typeof u.costUsd === "number" && u.costUsd >= 0;
  // A stopped turn that spent nothing leaves no row.
  if (finished || tokensIn + tokensOut > 0) {
    await addRow({
      ...base,
      source: u.automation ? "automation" : "chat",
      turns: finished ? 1 : 0,
      deepTurns: finished && u.deep ? 1 : 0,
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cacheReadTokens: Math.min(tokensIn, nonNeg(u.cacheReadTokens)),
      cacheWriteTokens: Math.min(tokensIn, nonNeg(u.cacheWriteTokens)),
      estCostMicros: priced ? Math.round((u.costUsd as number) * 1e6) : 0,
      pricedTurns: priced ? 1 : 0,
      unpricedTurns: u.costUsd === null ? 1 : 0,
    });
  }
  for (const a of u.aux ?? []) {
    await addRow({
      ...base,
      source: a.source,
      turns: 0,
      deepTurns: 0,
      inputTokens: nonNeg(a.inputTokens),
      outputTokens: nonNeg(a.outputTokens),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estCostMicros: 0,
      pricedTurns: 0,
      unpricedTurns: 0,
    });
  }
  const { skills, mcp } = toolRunsFrom(u.messages);
  for (const [kind, runs] of [
    ["skill", skills],
    ["mcp", mcp],
  ] as const) {
    for (const [name, n] of runs) {
      await db
        .insert(usageToolStats)
        .values({ day, kind, name, runs: n })
        .onConflictDoUpdate({
          target: [
            usageToolStats.day,
            usageToolStats.kind,
            usageToolStats.name,
          ],
          set: { runs: sql`${usageToolStats.runs} + ${n}` },
        });
    }
  }
}

/** One Atlarix Auto reply: the model that answered and who paid, from its headers. */
export async function recordAutoPick(p: {
  servedModel: string | null;
  billing: "free" | "paid" | null;
  tier?: string | null;
  surface?: ActivitySurface;
  now?: Date;
}): Promise<void> {
  const servedModel = (p.servedModel ?? "").trim().slice(0, 120);
  if (!servedModel || !p.billing) return;
  const t = usageAutoPicks;
  await db
    .insert(t)
    .values({
      day: localDayKey(p.now ?? new Date()),
      surface: p.surface ?? currentSurface(),
      billing: p.billing,
      tier: (p.tier ?? "").trim().toLowerCase().slice(0, 20),
      servedModel,
      steps: 1,
    })
    .onConflictDoUpdate({
      target: [t.day, t.surface, t.billing, t.tier, t.servedModel],
      set: { steps: sql`${t.steps} + 1` },
    });
}

export function recordAutoPickSafely(
  p: Parameters<typeof recordAutoPick>[0],
): void {
  void recordAutoPick(p).catch((e) =>
    logger.warn("failed to record an Auto pick", e),
  );
}

/** Statistics must never fail a turn: the turn has already finished. */
export function recordTurnUsageSafely(u: TurnUsage): void {
  void recordTurnUsage(u).catch((e) =>
    logger.warn("failed to record turn usage", e),
  );
}

// ─── Reading ────────────────────────────────────────────────────────────────

export type { ActivityDay, ActivityStats } from "./usage-types";

const WEEKS = 53;
const MS_PER_DAY = 86_400_000;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Consecutive active days: the run ending today (or yesterday, if today is quiet yet) and the longest. */
export function streaks(
  activeDays: ReadonlySet<string>,
  today: Date,
): { current: number; longest: number } {
  const sorted = [...activeDays].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run =
      prev &&
      localDayString(
        new Date(parseLocalDay(prev).getTime() + MS_PER_DAY + 3_600_000),
      ) === d
        ? run + 1
        : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  const step = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!activeDays.has(localDayString(cursor))) cursor = step(cursor);
  let current = 0;
  while (activeDays.has(localDayString(cursor))) {
    current++;
    cursor = step(cursor);
  }
  return { current, longest };
}

/** The calendar: 53 week columns ending this week, each Sunday→Saturday. */
export function activityCalendar(
  turnsByDay: ReadonlyMap<string, number>,
  today: Date,
): Pick<ActivityStats, "weeks" | "monthLabels"> {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(
    end.getFullYear(),
    end.getMonth(),
    end.getDate() - end.getDay() - (WEEKS - 1) * 7,
  );
  const thresholds = bucketThresholds([...turnsByDay.values()]);
  const weeks: ActivityDay[][] = [];
  const monthLabels: (string | null)[] = [];
  let lastMonth = -1;
  for (let w = 0; w < WEEKS; w++) {
    const col: ActivityDay[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + w * 7 + d,
      );
      const day = localDayString(date);
      const turns = turnsByDay.get(day) ?? 0;
      col.push({
        day,
        turns,
        level: levelFor(turns, thresholds),
        inRange: date <= end,
      });
    }
    const month = parseLocalDay(col[0]!.day).getMonth();
    monthLabels.push(month !== lastMonth ? MONTHS[month]! : null);
    lastMonth = month;
    weeks.push(col);
  }
  return { weeks, monthLabels };
}

/** A rollup row from either table; `usage_stats` rows read as chat turns with no cache split or cost. */
export type UsageRollupRow = typeof usageRollup.$inferSelect;

/** Every rollup row: `usage_rollup`, plus what older builds still write to `usage_stats`. */
export async function usageRows(): Promise<UsageRollupRow[]> {
  const current = await db.select().from(usageRollup);
  const legacy = await db.select().from(usageStats);
  return [
    ...current,
    ...legacy.map((r) => ({
      ...r,
      editor: "",
      source: "chat",
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estCostMicros: 0,
      pricedTurns: 0,
      unpricedTurns: 0,
    })),
  ];
}

/** Gaps longer than this between two messages are a break, not work. */
export const ACTIVE_GAP_SECONDS = 30 * 60;

/** How a chat's selected model (display snapshot) groups with the dispatched one. */
function historyModel(
  provider: string,
  name: string,
): { provider: string; modelId: string } {
  if (provider !== "compass") return { provider, modelId: name };
  // A Core tier id names a slot, whose model has changed since; never re-resolve it.
  return {
    provider,
    modelId: name === "core-auto" ? "atlarix/auto" : "atlarix/core",
  };
}

const share = (n: number, total: number) =>
  total > 0 ? Math.round((n / total) * 1000) / 10 : 0;

export async function getActivityStats(
  now: Date = new Date(),
): Promise<ActivityStats> {
  const rows = await usageRows();
  const tools = await db.select().from(usageToolStats);
  const raw = (
    db as unknown as {
      $client: { prepare(q: string): { all(...a: unknown[]): unknown[] } };
    }
  ).$client;

  // Turns per day: the rollup where it exists, the chat history before it.
  const recordedSince = rows.length
    ? rows.reduce((m, r) => (r.day < m ? r.day : m), rows[0]!.day)
    : null;
  const turnsByDay = new Map<string, number>();
  const tokensByDay = new Map<string, number>();
  for (const r of rows) {
    turnsByDay.set(r.day, (turnsByDay.get(r.day) ?? 0) + r.turns);
    tokensByDay.set(
      r.day,
      (tokensByDay.get(r.day) ?? 0) + r.inputTokens + r.outputTokens,
    );
  }
  const history = raw
    .prepare(
      "SELECT date(created_at, 'unixepoch', 'localtime') AS day, COUNT(*) AS n FROM session_messages WHERE role = 'user' AND kind = 'message' GROUP BY day",
    )
    .all() as Array<{ day: string; n: number }>;
  for (const h of history) {
    if (recordedSince && h.day > recordedSince) continue;
    // The upgrade day: chats before the rollup began count too (QA 15.7.1).
    if (h.day === recordedSince) {
      turnsByDay.set(h.day, Math.max(turnsByDay.get(h.day) ?? 0, h.n));
      continue;
    }
    turnsByDay.set(h.day, (turnsByDay.get(h.day) ?? 0) + h.n);
  }
  const activeDays = new Set(
    [...turnsByDay].filter(([, n]) => n > 0).map(([d]) => d),
  );
  const since = activeDays.size ? [...activeDays].sort()[0]! : null;

  // Active time, not first-to-last: a chat reopened a week later was not a week long.
  const longest = raw
    .prepare(
      `SELECT s.title AS title, g.span AS span FROM (
         SELECT session_id, SUM(CASE WHEN gap <= ? THEN gap ELSE 0 END) AS span FROM (
           SELECT session_id, created_at - LAG(created_at) OVER (PARTITION BY session_id ORDER BY created_at) AS gap
           FROM session_messages
         ) GROUP BY session_id
       ) g JOIN chat_sessions s ON s.id = g.session_id ORDER BY g.span DESC LIMIT 1`,
    )
    .all(ACTIVE_GAP_SECONDS) as Array<{
    title: string | null;
    span: number | null;
  }>;
  // Models before the rollup: the model each reply's chat had selected.
  const historyModels = recordedSince
    ? (raw
        .prepare(
          `SELECT json_extract(display_snapshot, '$.model.provider') AS provider,
                  json_extract(display_snapshot, '$.model.name') AS name, COUNT(*) AS n
           FROM session_messages
           WHERE role = 'assistant' AND json_valid(display_snapshot)
             AND date(created_at, 'unixepoch', 'localtime') < ?
             AND json_extract(display_snapshot, '$.model.name') IS NOT NULL
           GROUP BY provider, name`,
        )
        .all(recordedSince) as Array<{
        provider: string | null;
        name: string;
        n: number;
      }>)
    : [];
  const chats = raw
    .prepare(
      "SELECT COUNT(DISTINCT session_id) AS n FROM session_messages WHERE role = 'user'",
    )
    .all() as Array<{ n: number }>;
  const providerNames = Object.fromEntries(
    (
      raw
        .prepare("SELECT id, name FROM language_model_providers")
        .all() as Array<{
        id: string;
        name: string | null;
      }>
    )
      .filter((p) => p.name?.trim())
      .map((p) => [p.id, printableName(p.name!, 40)]),
  );
  const lines = raw
    .prepare(
      "SELECT COALESCE(SUM(lines_added + lines_removed), 0) AS n FROM edit_stats",
    )
    .all() as Array<{ n: number }>;

  const recordedTurns = rows.reduce((s, r) => s + r.turns, 0);
  let historyModelTurns = 0;
  const byModel = new Map<
    string,
    { provider: string; modelId: string; turns: number }
  >();
  const byMode = new Map<string, number>();
  const bySurface = new Map<ActivitySurface, number>();
  let deep = 0;
  for (const r of rows) {
    const key = `${r.provider}\u0000${r.modelId}`;
    const m = byModel.get(key) ?? {
      provider: r.provider,
      modelId: r.modelId,
      turns: 0,
    };
    m.turns += r.turns;
    byModel.set(key, m);
    byMode.set(r.mode, (byMode.get(r.mode) ?? 0) + r.turns);
    bySurface.set(
      r.surface as ActivitySurface,
      (bySurface.get(r.surface as ActivitySurface) ?? 0) + r.turns,
    );
    deep += r.deepTurns;
  }
  for (const h of historyModels) {
    const k = historyModel(String(h.provider ?? "unknown"), String(h.name));
    const key = `${k.provider}\u0000${k.modelId}`;
    const m = byModel.get(key) ?? { ...k, turns: 0 };
    m.turns += Number(h.n) || 0;
    historyModelTurns += Number(h.n) || 0;
    byModel.set(key, m);
  }
  const byEditor = new Map<string, number>();
  for (const r of rows) {
    if (r.surface === "editor" && r.editor && r.turns > 0) {
      byEditor.set(r.editor, (byEditor.get(r.editor) ?? 0) + r.turns);
    }
  }
  const top = (kind: string) => {
    const by = new Map<string, number>();
    for (const t of tools)
      if (t.kind === kind) by.set(t.name, (by.get(t.name) ?? 0) + t.runs);
    return [...by]
      .map(([name, runs]) => ({ name, runs }))
      .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
      .slice(0, 5);
  };
  const peak = [...tokensByDay].sort((a, b) => b[1] - a[1])[0];
  const { current, longest: longestStreak } = streaks(activeDays, now);

  return {
    since,
    recordedSince,
    lifetimeTokens: [...tokensByDay.values()].reduce((s, n) => s + n, 0),
    peakDay: peak && peak[1] > 0 ? { day: peak[0], tokens: peak[1] } : null,
    longestChat:
      longest[0] && (longest[0].span ?? 0) > 0
        ? {
            title: longest[0].title || "Untitled",
            minutes: Math.round((longest[0].span ?? 0) / 60),
          }
        : null,
    currentStreak: current,
    longestStreak,
    totalChats: Number(chats[0]?.n ?? 0),
    totalTurns: [...turnsByDay.values()].reduce((s, n) => s + n, 0),
    ...activityCalendar(turnsByDay, now),
    models: [...byModel.values()]
      .sort((a, b) => b.turns - a.turns || a.modelId.localeCompare(b.modelId))
      .slice(0, 5)
      .map((m) => ({
        ...m,
        share: share(m.turns, recordedTurns + historyModelTurns),
      })),
    modes: [...byMode]
      .sort((a, b) => b[1] - a[1])
      .map(([mode, n]) => ({ mode, share: share(n, recordedTurns) })),
    deepShare: share(deep, recordedTurns),
    surfaces: [...bySurface]
      .filter(([, turns]) => turns > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([surface, turns]) => ({ surface, turns })),
    editors: [...byEditor]
      .sort((a, b) => b[1] - a[1])
      .map(([editor, turns]) => ({ editor, turns })),
    skills: top("skill"),
    mcp: top("mcp"),
    linesWritten: Number(lines[0]?.n ?? 0),
    providerNames,
    asOf: localDayKey(now),
  };
}
