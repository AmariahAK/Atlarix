/**
 * How "Your activity" reads, the same on every surface (app card, CLI and ACP
 * /stats, VS Code's Account panel). Renderer-safe: no database, no Node.
 */

import type { ActivityStats } from "./usage-types";
import { usageModelLabel, usageSurfaceLabel } from "./usage-labels";

/** 472.4M, 68.7K, 950. */
export function compactCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 1h 24m, 3d 2h, 12m. */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ${Math.round(minutes % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The work mode as the mode picker names it (the turn records its key). */
export function activityModeLabel(mode: string): string {
  const names: Record<string, string> = {
    ask: "Explore",
    explore: "Explore",
    build: "Build",
    plan: "Plan",
    debug: "Debug",
    review: "Review",
  };
  return names[mode] ?? mode.charAt(0).toUpperCase() + mode.slice(1);
}

export function activitySurfaceLabel(surface: string): string {
  return surface === "cli"
    ? "CLI"
    : surface === "editor"
      ? "Editors (VS Code, Zed, JetBrains)"
      : "App";
}

// ─── As text: the CLI's and ACP's /stats ─────────────────────────────────────

/** Calendar levels 0-4 as shading, one character a week: fits an 80-column terminal. */
export const CALENDAR_GLYPHS = ["·", "░", "▒", "▓", "█"] as const;
const WEEKDAY_ROWS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** The calendar as rows: months, then Sunday→Saturday, then the key. `weeks` trims to fit. */
export function calendarRows(
  s: Pick<ActivityStats, "weeks" | "monthLabels">,
  weeks = 53,
): string[] {
  const cols = s.weeks.slice(-weeks);
  const labels = s.monthLabels.slice(-weeks);
  const gutter = 3;
  let months = " ".repeat(gutter);
  labels.forEach((m, i) => {
    if (!m) return;
    // A name that would run into the next month's gives way to it: the partial
    // first month, not the month after it ("OctNov", then "Oct     Dec").
    const next = labels.findIndex((x, j) => j > i && !!x);
    if (next !== -1 && next - i <= m.length) return;
    if (months.length === gutter || months.length < gutter + i)
      months = months.padEnd(gutter + i) + m;
  });
  const rows = WEEKDAY_ROWS.map(
    (name, d) =>
      `${name} ${cols.map((w) => (w[d]?.inRange ? CALENDAR_GLYPHS[w[d]!.level] : " ")).join("")}`,
  );
  return [
    months.trimEnd(),
    ...rows,
    `${" ".repeat(gutter)}Less ${CALENDAR_GLYPHS.join(" ")} More`,
  ];
}

export interface ActivitySection {
  title: string;
  rows: Array<{ label: string; value: string }>;
}

/** The five numbers along the top. */
export function activityTiles(
  s: ActivityStats,
): Array<{ label: string; value: string }> {
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
  return [
    { label: "Lifetime tokens", value: compactCount(s.lifetimeTokens) },
    {
      label: "Busiest day",
      value: s.peakDay ? compactCount(s.peakDay.tokens) : "—",
    },
    {
      label: "Longest session",
      value: s.longestChat ? durationLabel(s.longestChat.minutes) : "—",
    },
    { label: "Current streak", value: days(s.currentStreak) },
    { label: "Longest streak", value: days(s.longestStreak) },
  ];
}

/** Models, modes, where, skills, MCP and totals; empty sections are left out. */
export function activitySections(s: ActivityStats): ActivitySection[] {
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  return [
    {
      title: "Favourite models",
      rows: s.models.map((m) => ({
        label: usageModelLabel(m),
        value: `${m.share}%`,
      })),
    },
    {
      title: "Modes",
      rows: [
        ...s.modes.map((m) => ({
          label: activityModeLabel(m.mode),
          value: `${m.share}%`,
        })),
        ...(s.deepShare > 0
          ? [{ label: "Deep thinking", value: `${s.deepShare}%` }]
          : []),
      ],
    },
    {
      title: "Most used skills",
      rows: s.skills.map((x) => ({
        label: x.name,
        value: plural(x.runs, "run", "runs"),
      })),
    },
    {
      title: "Most used MCP servers",
      rows: s.mcp.map((x) => ({
        label: x.name,
        value: plural(x.runs, "call", "calls"),
      })),
    },
    {
      title: "Where you work",
      rows: [
        ...s.surfaces
          // Named editors list themselves below; the rest stay one row.
          .map((x) => ({
            ...x,
            turns: x.surface === "editor" ? x.turns - (s.editors ?? []).reduce((n, e) => n + e.turns, 0) : x.turns,
          }))
          .filter((x) => x.turns > 0)
          .map((x) => ({
            label: activitySurfaceLabel(x.surface),
            value: plural(x.turns, "turn", "turns"),
          })),
        ...(s.editors ?? []).map((e) => ({
          label: usageSurfaceLabel(e.editor),
          value: plural(e.turns, "turn", "turns"),
        })),
      ],
    },
    {
      title: "Totals",
      rows: [
        { label: "Chats", value: s.totalChats.toLocaleString("en-US") },
        { label: "Turns", value: s.totalTurns.toLocaleString("en-US") },
        ...(s.linesWritten > 0
          ? [
              {
                label: "Lines written",
                value: s.linesWritten.toLocaleString("en-US"),
              },
            ]
          : []),
      ],
    },
  ].filter((x) => x.rows.length > 0);
}

/** What the numbers cover. */
export function activityFootnote(s: ActivityStats): string {
  return `Stored only on this computer. ${
    s.recordedSince
      ? `Tokens, models, skills and MCP servers count from ${s.recordedSince}.`
      : "Tokens, models, skills and MCP servers count from your next chat."
  } As of ${s.asOf}.`;
}

/** /stats in an editor chat (Zed, JetBrains, VS Code): markdown, the calendar in a code block. */
export function statsMarkdown(s: ActivityStats): string {
  if (!s.since)
    return "**Your activity**\n\nNo activity yet.";
  const out = [
    "**Your activity** (this computer)",
    "",
    activityTiles(s)
      .map((t) => `**${t.value}** ${t.label.toLowerCase()}`)
      .join(" · "),
    "",
    "Last 6 months:",
    "```",
    ...calendarRows(s, 26),
    "```",
  ];
  for (const section of activitySections(s)) {
    out.push(
      "",
      `**${section.title}**`,
      "",
      ...section.rows.map((r) => `- ${r.label}: ${r.value}`),
    );
  }
  out.push("", `_${activityFootnote(s)}_`);
  return out.join("\n");
}
