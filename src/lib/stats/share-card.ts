/**
 * The Usage page's share card: a year's calendar, the streaks and lifetime
 * tokens, as one self-contained SVG (1200×630, the size link previews use).
 * The app and VS Code turn it into a PNG; the CLI saves the SVG.
 *
 * Only numbers and the calendar: never a chat title, project, skill, MCP server
 * or model name, because a card is made to be posted.
 */

import { compactCount } from "./activity-format";
import type { ActivityStats } from "./usage-types";

/** The dark theme's calendar shades (globals.css `--calendar-0..4`), fixed: a posted image has no theme. */
const SHADES = ["#1e3325", "#0e4429", "#12805a", "#10b981", "#6ee7b7"] as const;
const W = 1200;
const H = 630;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function shareCardSvg(
  s: Pick<
    ActivityStats,
    "weeks" | "monthLabels" | "currentStreak" | "longestStreak" | "lifetimeTokens" | "totalTurns" | "since"
  >,
): string {
  const activeDays = s.weeks.flat().filter((d) => d.inRange && d.turns > 0).length;
  const cell = 17;
  const gap = 4;
  const cols = s.weeks.length;
  const gridW = cols * (cell + gap) - gap;
  const left = Math.round((W - gridW) / 2);
  const top = 300;
  const rects: string[] = [];
  s.weeks.forEach((week, w) =>
    week.forEach((d, i) => {
      if (!d.inRange) return;
      rects.push(
        `<rect x="${left + w * (cell + gap)}" y="${top + i * (cell + gap)}" width="${cell}" height="${cell}" rx="3" fill="${SHADES[d.level]}"/>`,
      );
    }),
  );
  const months = s.monthLabels
    .map((m, w) =>
      m && w < cols - 1
        ? `<text x="${left + w * (cell + gap)}" y="${top - 12}" font-size="16" fill="#8b9a90">${esc(m)}</text>`
        : "",
    )
    .join("");
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
  const stats = [
    { value: days(s.currentStreak), label: "Current streak" },
    { value: days(s.longestStreak), label: "Longest streak" },
    { value: compactCount(s.lifetimeTokens), label: "Tokens" },
    { value: String(activeDays), label: "Active days this year" },
  ];
  const colW = gridW / stats.length;
  const tiles = stats
    .map(
      (t, i) =>
        `<text x="${left + i * colW}" y="200" font-size="44" font-weight="700" fill="#f2f5f3">${esc(t.value)}</text>` +
        `<text x="${left + i * colW}" y="236" font-size="20" fill="#8b9a90">${esc(t.label)}</text>`,
    )
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, -apple-system, 'Segoe UI', sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#0b120e"/>`,
    `<text x="${left}" y="104" font-size="30" font-weight="700" fill="#f2f5f3">Atlarix</text>`,
    tiles,
    months,
    ...rects,
    `<text x="${left}" y="${top + 7 * (cell + gap) + 36}" font-size="16" fill="#8b9a90">${esc(
      s.since ? `Since ${s.since}` : "",
    )}</text>`,
    `<text x="${left + gridW}" y="${top + 7 * (cell + gap) + 36}" font-size="16" text-anchor="end" fill="#8b9a90">atlarix.dev</text>`,
    `</svg>`,
  ].join("");
}
