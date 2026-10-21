/**
 * Your activity — the agent's finished turns on this computer, for the stats
 * page every surface shows (app, CLI, VS Code, ACP).
 *
 * WHAT IS RECORDED. One upsert per finished turn into two daily rollups
 * (`usage_stats`, `usage_tool_stats`): the surface, the model as DISPATCHED (via
 * the same resolution as edit stats), the work mode, deep thinking, tokens, and
 * which skills and MCP servers the turn used. No prompt text, no file paths.
 * Local to this computer: the app, CLI and editors share the one database.
 *
 * WHAT IS DERIVED. Days and chats older than the rollup come from the chat
 * history itself (one user message = one turn), so the calendar, streaks and
 * longest chat are right from the first day of this release; tokens, models and
 * tools only count from then ("since" says when).
 */

import log from "electron-log";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { usageStats, usageToolStats } from "@/db/schema";
import { localDayKey } from "./edit-stats";
import {
  bucketThresholds,
  levelFor,
  localDayString,
  parseLocalDay,
  type CalendarLevel,
} from "./edit-stats-calendar";

const logger = log.scope("usage-stats");

export type ActivitySurface = "app" | "cli" | "editor";

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
  const bump = (m: Map<string, number>, k: string) =>
    m.set(k, (m.get(k) ?? 0) + 1);
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

export interface TurnUsage {
  model: { provider: string; name: string } | null;
  mode: string;
  deep: boolean;
  inputTokens: number;
  outputTokens: number;
  messages: readonly unknown[];
  surface?: ActivitySurface;
  now?: Date;
}

export async function recordTurnUsage(u: TurnUsage): Promise<void> {
  const day = localDayKey(u.now ?? new Date());
  const tokensIn = Math.max(0, Math.round(u.inputTokens || 0));
  const tokensOut = Math.max(0, Math.round(u.outputTokens || 0));
  await db
    .insert(usageStats)
    .values({
      day,
      surface: u.surface ?? currentSurface(),
      provider: u.model?.provider ?? "unknown",
      modelId: u.model?.name ?? "unknown",
      mode: u.mode || "build",
      turns: 1,
      deepTurns: u.deep ? 1 : 0,
      inputTokens: tokensIn,
      outputTokens: tokensOut,
    })
    .onConflictDoUpdate({
      target: [
        usageStats.day,
        usageStats.surface,
        usageStats.provider,
        usageStats.modelId,
        usageStats.mode,
      ],
      set: {
        turns: sql`${usageStats.turns} + 1`,
        deepTurns: sql`${usageStats.deepTurns} + ${u.deep ? 1 : 0}`,
        inputTokens: sql`${usageStats.inputTokens} + ${tokensIn}`,
        outputTokens: sql`${usageStats.outputTokens} + ${tokensOut}`,
      },
    });
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

/** Statistics must never fail a turn: the turn has already finished. */
export function recordTurnUsageSafely(u: TurnUsage): void {
  void recordTurnUsage(u).catch((e) =>
    logger.warn("failed to record turn usage", e),
  );
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface ActivityDay {
  day: string;
  turns: number;
  level: CalendarLevel;
  /** False for cells padding the first week: drawn blank, not as a zero day. */
  inRange: boolean;
}

export interface ActivityStats {
  /** The first day with any activity, or null for none yet. */
  since: string | null;
  /** The first day tokens, models and tools were recorded (this release). */
  recordedSince: string | null;
  lifetimeTokens: number;
  peakDay: { day: string; tokens: number } | null;
  longestChat: { title: string; minutes: number } | null;
  currentStreak: number;
  longestStreak: number;
  totalChats: number;
  totalTurns: number;
  /** The last 53 weeks, a column per week Sunday→Saturday, oldest first. */
  weeks: ActivityDay[][];
  /** A month name over the week it starts in, else null. */
  monthLabels: (string | null)[];
  models: Array<{
    provider: string;
    modelId: string;
    turns: number;
    share: number;
  }>;
  modes: Array<{ mode: string; share: number }>;
  deepShare: number;
  surfaces: Array<{ surface: ActivitySurface; turns: number }>;
  skills: Array<{ name: string; runs: number }>;
  mcp: Array<{ name: string; runs: number }>;
  linesWritten: number;
  asOf: string;
}

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

const share = (n: number, total: number) =>
  total > 0 ? Math.round((n / total) * 1000) / 10 : 0;

export async function getActivityStats(
  now: Date = new Date(),
): Promise<ActivityStats> {
  const rows = await db.select().from(usageStats);
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

  const longest = raw
    .prepare(
      "SELECT s.title AS title, MAX(m.created_at) - MIN(m.created_at) AS span FROM session_messages m JOIN chat_sessions s ON s.id = m.session_id GROUP BY m.session_id ORDER BY span DESC LIMIT 1",
    )
    .all() as Array<{ title: string | null; span: number }>;
  const chats = raw
    .prepare(
      "SELECT COUNT(DISTINCT session_id) AS n FROM session_messages WHERE role = 'user'",
    )
    .all() as Array<{ n: number }>;
  const lines = raw
    .prepare(
      "SELECT COALESCE(SUM(lines_added + lines_removed), 0) AS n FROM edit_stats",
    )
    .all() as Array<{ n: number }>;

  const recordedTurns = rows.reduce((s, r) => s + r.turns, 0);
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
      longest[0] && longest[0].span > 0
        ? {
            title: longest[0].title || "Untitled",
            minutes: Math.round(longest[0].span / 60),
          }
        : null,
    currentStreak: current,
    longestStreak,
    totalChats: Number(chats[0]?.n ?? 0),
    totalTurns: [...turnsByDay.values()].reduce((s, n) => s + n, 0),
    ...activityCalendar(turnsByDay, now),
    models: [...byModel.values()]
      .sort((a, b) => b.turns - a.turns)
      .slice(0, 5)
      .map((m) => ({ ...m, share: share(m.turns, recordedTurns) })),
    modes: [...byMode]
      .sort((a, b) => b[1] - a[1])
      .map(([mode, n]) => ({ mode, share: share(n, recordedTurns) })),
    deepShare: share(deep, recordedTurns),
    surfaces: [...bySurface]
      .sort((a, b) => b[1] - a[1])
      .map(([surface, turns]) => ({ surface, turns })),
    skills: top("skill"),
    mcp: top("mcp"),
    linesWritten: Number(lines[0]?.n ?? 0),
    asOf: localDayKey(now),
  };
}
