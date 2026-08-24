/**
 * The contribution calendar's arithmetic — bucketing and grid layout.
 *
 * Pure, and separate from the component, because this is where the judgement is: a
 * heatmap is only as good as its scale, and a scale is exactly the kind of thing that
 * looks fine by eye while being wrong on real data.
 */

import type { EditStatsDayRow } from "@/ipc/ipc_types";

/** 0 = no activity; 1–4 = quartile of the days that DID have activity. */
export type CalendarLevel = 0 | 1 | 2 | 3 | 4;

/** Days of history required before the calendar is worth showing at all. */
export const MIN_DAYS_FOR_CALENDAR = 7;

/** Grid width bounds, in weeks. */
export const MIN_CALENDAR_WEEKS = 8;
export const MAX_CALENDAR_WEEKS = 53;

/** Lines changed on a day — the metric the card's headline number uses. */
export function dayTotal(row: EditStatsDayRow): number {
  return row.linesAdded + row.linesRemoved;
}

/**
 * The three cuts that divide active days into four levels.
 *
 * QUARTILES OF THE NON-ZERO DAYS, and both halves of that matter:
 *
 * - *Quartiles*, not equal slices of the range, because lines-changed is long-tailed.
 *   One refactor day of 5,000 lines against ordinary days of 40 makes a linear scale
 *   useless: the refactor is the only visible square and everything else collapses
 *   into the lightest step. GitHub can get away with near-linear because commit counts
 *   cluster in single digits; this measure does not.
 * - *Non-zero*, because a day with no work is not a small amount of work. Including
 *   zeros would drag every cut toward zero and undo the point of using quantiles.
 *
 * Deduped: while history is short there are only a handful of distinct totals and the
 * naive quartiles land on top of each other, which would silently create empty levels.
 */
export function bucketThresholds(values: readonly number[]): number[] {
  const active = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (active.length === 0) return [];
  const at = (fraction: number): number => {
    const idx = Math.min(
      active.length - 1,
      Math.max(0, Math.ceil(fraction * active.length) - 1),
    );
    return active[idx]!;
  };
  const cuts = [at(0.25), at(0.5), at(0.75)];
  return [...new Set(cuts)].sort((a, b) => a - b);
}

/**
 * Which shade a day gets.
 *
 * A day with ANY activity is at least level 1 — never level 0. Level 0 is reserved for
 * "nothing happened", and letting a real (if small) day of work render as an empty
 * square would make the graph lie about the thing it exists to show.
 */
export function levelFor(
  total: number,
  thresholds: readonly number[],
): CalendarLevel {
  if (total <= 0) return 0;
  let level = 1;
  for (const t of thresholds) {
    if (total > t) level += 1;
  }
  return Math.min(4, level) as CalendarLevel;
}

/** Whether there is enough history for the grid to be worth drawing. */
export function shouldShowCalendar(byDay: readonly EditStatsDayRow[]): boolean {
  return byDay.filter((d) => dayTotal(d) > 0).length >= MIN_DAYS_FOR_CALENDAR;
}

export type CalendarCell = {
  /** LOCAL `YYYY-MM-DD`. */
  day: string;
  linesAdded: number;
  linesRemoved: number;
  edits: number;
  level: CalendarLevel;
  /** False for cells padding the first/last week — rendered blank, not as zero days. */
  inRange: boolean;
};

export type CalendarGrid = {
  /** Column per week, each column Sunday→Saturday. */
  weeks: CalendarCell[][];
  /** Month label per week column, or null when it repeats the previous column. */
  monthLabels: (string | null)[];
  thresholds: number[];
};

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` in LOCAL time — the same key `edit_stats.day` is written with. */
export function localDayString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a `YYYY-MM-DD` key as a LOCAL midnight, never as UTC. */
export function parseLocalDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

/**
 * Build the grid.
 *
 * The window starts at the first recorded day and ends today, rather than always
 * spanning a year. With no backfill, history begins the day this ships — a fixed
 * 53-week grid would be ~360 blank squares and one green one, which reads as broken
 * rather than as new. Growing from a short strip into a full year says the true thing
 * at every point, with no cliff between the two states.
 *
 * The floor (8 weeks) stops it from being a stub two columns wide; the cap (53) is a
 * year, after which the window slides.
 */
export function buildCalendarGrid(
  byDay: readonly EditStatsDayRow[],
  today: Date = new Date(),
): CalendarGrid {
  const byKey = new Map(byDay.map((d) => [d.day, d]));
  const thresholds = bucketThresholds(byDay.map(dayTotal));

  const active = byDay.filter((d) => dayTotal(d) > 0);
  const firstRecorded =
    active.length > 0 ? parseLocalDay(active[0]!.day) : new Date(today);

  // End on the Saturday of this week, so the final column is a whole week and today
  // is not stranded in a half-drawn column.
  const end = new Date(today);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + (6 - end.getDay()));

  // Start on a Sunday, so every column is Sunday→Saturday.
  const startFromData = new Date(firstRecorded);
  startFromData.setHours(0, 0, 0, 0);
  startFromData.setDate(startFromData.getDate() - startFromData.getDay());

  const weeksSpanned =
    Math.round((end.getTime() - startFromData.getTime()) / (7 * MS_PER_DAY)) + 1;
  const weekCount = Math.min(
    MAX_CALENDAR_WEEKS,
    Math.max(MIN_CALENDAR_WEEKS, weeksSpanned),
  );

  const start = new Date(end);
  start.setDate(start.getDate() - (weekCount * 7 - 1));

  const todayKey = localDayString(today);
  const weeks: CalendarCell[][] = [];
  const monthLabels: (string | null)[] = [];
  let lastMonth = -1;

  for (let w = 0; w < weekCount; w++) {
    const column: CalendarCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(date.getDate() + w * 7 + d);
      const key = localDayString(date);
      const row = byKey.get(key);
      // A future day in the current week is not a zero day — it has not happened.
      const inRange = key <= todayKey;
      column.push({
        day: key,
        linesAdded: row?.linesAdded ?? 0,
        linesRemoved: row?.linesRemoved ?? 0,
        edits: row?.edits ?? 0,
        level: row ? levelFor(dayTotal(row), thresholds) : 0,
        inRange,
      });
    }
    weeks.push(column);

    // Label a column with its month only when the month changes, so labels read as
    // boundaries rather than repeating across every column.
    const firstOfColumn = parseLocalDay(column[0]!.day);
    const month = firstOfColumn.getMonth();
    if (month !== lastMonth) {
      monthLabels.push(
        firstOfColumn.toLocaleDateString(undefined, { month: "short" }),
      );
      lastMonth = month;
    } else {
      monthLabels.push(null);
    }
  }

  return { weeks, monthLabels, thresholds };
}

/**
 * The sentence a cell carries — used for BOTH the tooltip and the `aria-label`.
 *
 * One function so the two cannot drift: the accessible name and the visible hover text
 * describing the same square differently is its own small lie.
 */
export function describeCalendarCell(cell: CalendarCell): string {
  const date = parseLocalDay(cell.day).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  if (!cell.inRange) return date;
  const total = cell.linesAdded + cell.linesRemoved;
  if (total <= 0) return `${date} — no changes`;
  const edits = `${cell.edits} ${cell.edits === 1 ? "edit" : "edits"}`;
  return `${date} — +${cell.linesAdded.toLocaleString()} −${cell.linesRemoved.toLocaleString()} across ${edits}`;
}
