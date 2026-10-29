/**
 * The Usage page as text, the same in the CLI (/usage) and an editor chat (ACP
 * /usage). Renderer-safe: no database, no Node. The app and VS Code draw the
 * same numbers as charts.
 */

import type { UsageCredits, UsageReport } from "./usage-types";
import { compactCount } from "./activity-format";
import { printableName, usageSourceLabel, usdLabel } from "./usage-labels";

/** The windows a Usage page can show, in days. */
export const USAGE_RANGES = [30, 90, 365] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const USAGE_TABS = [
  { key: "overview", label: "Overview" },
  { key: "credits", label: "Credits" },
  { key: "tokens", label: "Tokens" },
  { key: "tools", label: "MCP & Skills" },
  { key: "auto", label: "Auto" },
] as const;
export type UsageTab = (typeof USAGE_TABS)[number]["key"];

/** One glyph per stacked series, densest first: tells five models apart without colour. */
export const SERIES_GLYPHS = ["█", "▓", "▒", "░", "▪", "·"] as const;

/** "Oct 29" for a local `YYYY-MM-DD`. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** A day's stacked bar: each series gets its share of `width` cells, scaled to the busiest day. */
export function stackedBar(
  values: readonly number[],
  max: number,
  width: number,
): string {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || max <= 0) return "";
  const cells = Math.max(1, Math.round((total / max) * width));
  let out = "";
  let used = 0;
  let carried = 0;
  values.forEach((v, i) => {
    carried += (v / total) * cells;
    const n = Math.round(carried) - used;
    if (n > 0)
      out += SERIES_GLYPHS[Math.min(i, SERIES_GLYPHS.length - 1)]!.repeat(n);
    used += Math.max(0, n);
  });
  return out;
}

export interface UsageTextLine {
  text: string;
  tone?: "muted" | "accent";
  bold?: boolean;
}

const dayRows = (
  byDay: ReadonlyArray<{ day: string; values: number[] }>,
  width: number,
  value: (total: number) => string,
): UsageTextLine[] => {
  const max = Math.max(
    0,
    ...byDay.map((d) => d.values.reduce((a, b) => a + b, 0)),
  );
  return byDay.map((d) => {
    const total = d.values.reduce((a, b) => a + b, 0);
    return {
      text: `${shortDay(d.day).padEnd(7)}${stackedBar(d.values, max, width).padEnd(width)} ${total > 0 ? value(total) : ""}`.trimEnd(),
    };
  });
};

/** The series key, packed onto as few lines as fit `width`; an item never breaks. */
export function legend(labels: readonly string[], width = 76): UsageTextLine[] {
  const items = labels.map(
    (l, i) => `${SERIES_GLYPHS[Math.min(i, SERIES_GLYPHS.length - 1)]} ${l}`,
  );
  const lines: string[] = [];
  for (const item of items) {
    const last = lines.at(-1);
    if (last != null && last.length + 3 + item.length <= width)
      lines[lines.length - 1] = `${last}   ${item}`;
    else lines.push(item);
  }
  return lines.map((text) => ({ text, tone: "muted" as const }));
}

/** Tokens per day, stacked by model, for the last `days` days of the report's window. */
export function tokensText(
  r: UsageReport,
  days = 30,
  width = 50,
): UsageTextLine[] {
  if (!r.tokens.since)
    return [{ text: "Tokens are counted from your next chat.", tone: "muted" }];
  const a = r.filters.applied;
  const filter = [
    a.model && r.filters.models.find((m) => m.key === a.model)?.label,
    a.surface && r.filters.surfaces.find((m) => m.key === a.surface)?.label,
    a.source && usageSourceLabel(a.source),
  ].filter(Boolean);
  const out: UsageTextLine[] = [
    {
      text: `${compactCount(r.tokens.total)} tokens · last ${r.range} days${filter.length ? ` · ${filter.join(" · ")}` : ""}`,
      bold: true,
    },
    ...dayRows(r.tokens.byDay.slice(-days), width, compactCount),
    ...legend(r.tokens.series.map((s) => s.label)),
  ];
  if (r.byok) {
    out.push(
      { text: "" },
      {
        text: `Your own keys, estimated at list price: ${usdLabel(r.byok.totalUsd)}`,
        bold: true,
      },
      {
        text:
          `An estimate, not a bill: ${r.byok.pricedTurns} turns from ${r.byok.since}` +
          (r.byok.unpricedTurns > 0
            ? `; ${r.byok.unpricedTurns} on models without a reliable price are left out.`
            : "."),
        tone: "muted",
      },
    );
  }
  out.push(
    { text: "" },
    { text: `Tokens are counted from ${r.tokens.since}.`, tone: "muted" },
  );
  return out;
}

export function toolsText(
  r: UsageReport,
  days = 30,
  width = 40,
): UsageTextLine[] {
  const any = r.tools.byDay.some((d) => d.mcp + d.skill > 0);
  if (!any)
    return [
      {
        text: `No MCP or skill calls in the last ${r.range} days.`,
        tone: "muted",
      },
    ];
  const out: UsageTextLine[] = [
    { text: `MCP & skill calls · last ${r.range} days`, bold: true },
    ...dayRows(
      r.tools.byDay
        .slice(-days)
        .map((d) => ({ day: d.day, values: [d.mcp, d.skill] })),
      width,
      (n) => String(n),
    ),
    ...legend(["MCP", "Skills"]),
  ];
  for (const [title, list, unit] of [
    ["MCP servers", r.tools.mcp, "call"],
    ["Skills", r.tools.skills, "run"],
  ] as const) {
    if (!list.length) continue;
    out.push({ text: "" }, { text: title, bold: true });
    for (const x of list)
      out.push({
        text: `  ${printableName(x.name, 40).padEnd(40)}  ${x.runs} ${unit}${x.runs === 1 ? "" : "s"}`,
      });
  }
  return out;
}

const tierLabel = (tier: string) => (tier === "zenith" ? "Zenith" : "Auto");

export function autoText(r: UsageReport): UsageTextLine[] {
  if (r.autoPicks.steps === 0)
    return [{ text: "Atlarix Auto hasn't answered yet.", tone: "muted" }];
  const zenith = r.autoPicks.models.some((m) => m.tier === "zenith");
  const out: UsageTextLine[] = [
    {
      text: `${r.autoPicks.steps} Auto steps · last ${r.range} days`,
      bold: true,
    },
  ];
  for (const m of r.autoPicks.models) {
    const where = `${zenith ? `${tierLabel(m.tier)}, ` : ""}${m.billing === "paid" ? "paid" : "free"}`;
    out.push({
      text: `  ${m.label.slice(0, 30).padEnd(30)}  ${`${m.share}%`.padStart(6)}  ${where}`,
    });
  }
  out.push(
    { text: "" },
    {
      text: `Which model answered each Auto step, from ${r.autoPicks.since}.`,
      tone: "muted",
    },
  );
  return out;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function creditsText(
  c: UsageCredits | null,
  days = 30,
  width = 40,
): UsageTextLine[] {
  if (!c) return [{ text: "Loading…", tone: "muted" }];
  if (c.state === "signed_out")
    return [{ text: "Sign in to see Atlarix credits.", tone: "muted" }];
  if (c.state === "unavailable")
    return [{ text: "Credits can't be read right now.", tone: "muted" }];
  const out: UsageTextLine[] = [
    { text: `Balance ${dollars(c.balanceCents)}`, bold: true },
  ];
  if (c.plan === "pro" && c.grantedTotalCents > 0) {
    out.push({
      text: `Pro allowance: ${dollars(c.grantedTotalCents - c.grantedCents)} of ${dollars(c.grantedTotalCents)} used${
        c.renewsAt
          ? ` · resets ${new Date(c.renewsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
          : ""
      }`,
    });
  }
  const spent = c.days.reduce(
    (n, d) =>
      n +
      d.autoPaidCents +
      d.coreCents +
      d.toolCents +
      d.otherCents +
      d.unsplitCents,
    0,
  );
  if (spent === 0) {
    out.push(
      { text: "" },
      { text: "No Atlarix credit used yet.", tone: "muted" },
    );
    return out;
  }
  const recent = c.days.slice(-days);
  const hasUnsplit = recent.some((d) => d.unsplitCents > 0);
  const hasOther = recent.some((d) => d.toolCents + d.otherCents > 0);
  out.push(
    { text: "" },
    { text: `Spent · last ${days} days`, bold: true },
    ...dayRows(
      recent.map((d) => ({
        day: d.day,
        values: [
          d.autoPaidCents,
          d.coreCents,
          d.toolCents + d.otherCents,
          d.unsplitCents,
        ],
      })),
      width,
      dollars,
    ),
    ...legend([
      "Auto",
      "Core",
      ...(hasOther || hasUnsplit ? ["Search, reviewer, cloud"] : []),
      ...(hasUnsplit ? ["Earlier, not split"] : []),
    ]),
  );
  return out;
}

/** /usage in an editor chat: markdown, the bars in code blocks. */
export function usageMarkdown(
  r: UsageReport,
  credits: UsageCredits | null,
  overview: string,
): string {
  const block = (lines: UsageTextLine[]) => {
    const [head, ...rest] = lines;
    // An empty tab is one line saying why: no heading, no empty code block.
    if (!rest.length) return `_${head?.text ?? ""}_`;
    return [
      `**${head?.text ?? ""}**`,
      "",
      "```",
      ...rest.map((l) => l.text),
      "```",
    ].join("\n");
  };
  return [
    overview,
    "",
    "**Credits**",
    "",
    "```",
    ...creditsText(credits).map((l) => l.text),
    "```",
    "",
    block(tokensText(r)),
    "",
    block(toolsText(r)),
    "",
    block(autoText(r)),
  ].join("\n");
}
