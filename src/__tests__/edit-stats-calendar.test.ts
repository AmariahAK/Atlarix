/**
 * The contribution calendar's arithmetic.
 *
 * The scale is the whole feature. Lines changed is long-tailed — one refactor day of
 * 5,000 lines against ordinary days of 40 — so a linear scale produces one visible
 * square and three hundred invisible ones, and it does that *silently*: the graph
 * renders, it just says nothing. These tests exist because that failure is invisible
 * by inspection.
 */

import { describe, it, expect } from "vitest";
import {
  bucketThresholds,
  levelFor,
  shouldShowCalendar,
  buildCalendarGrid,
  describeCalendarCell,
  dayTotal,
  localDayString,
  parseLocalDay,
  MIN_CALENDAR_WEEKS,
  MAX_CALENDAR_WEEKS,
  MIN_DAYS_FOR_CALENDAR,
} from "@/lib/stats/edit-stats-calendar";
import type { EditStatsDayRow } from "@/ipc/ipc_types";

const day = (
  d: string,
  added: number,
  removed = 0,
  edits = 1,
): EditStatsDayRow => ({
  day: d,
  linesAdded: added,
  linesRemoved: removed,
  edits,
});

describe("bucketThresholds — quantiles, not equal slices", () => {
  it("spreads a long-tailed distribution across all four levels", () => {
    // The real shape: many small days, one enormous one.
    const totals = [12, 20, 30, 45, 60, 90, 140, 5000];
    const thresholds = bucketThresholds(totals);
    const levels = totals.map((t) => levelFor(t, thresholds));
    expect(new Set(levels).size).toBeGreaterThanOrEqual(4);
    expect(levels[levels.length - 1]).toBe(4);
    expect(levels[0]).toBe(1);
  });

  it("beats a linear scale on exactly that data", () => {
    // What we are avoiding: quartering the RANGE puts everything but the outlier in
    // level 1, which is the "one blinding square" failure.
    const totals = [12, 20, 30, 45, 60, 90, 140, 5000];
    const max = Math.max(...totals);
    const linearLevels = totals.map((t) =>
      Math.min(4, Math.max(1, Math.ceil((t / max) * 4))),
    );
    expect(new Set(linearLevels).size).toBe(2); // 1 and 4 only — the bug
    expect(
      new Set(totals.map((t) => levelFor(t, bucketThresholds(totals)))).size,
    ).toBeGreaterThan(2);
  });

  it("ignores zero days when choosing the cuts", () => {
    // A day with no work is not a small amount of work. Counting zeros would drag
    // every cut toward zero.
    const withZeros = bucketThresholds([0, 0, 0, 0, 10, 20, 30, 40]);
    const withoutZeros = bucketThresholds([10, 20, 30, 40]);
    expect(withZeros).toEqual(withoutZeros);
  });

  it("dedupes cuts that collapse on a short history", () => {
    // Three identical days: naive quartiles would all land on 50 and create empty
    // levels between them.
    expect(bucketThresholds([50, 50, 50])).toEqual([50]);
  });

  it("returns no cuts when there is no activity at all", () => {
    expect(bucketThresholds([])).toEqual([]);
    expect(bucketThresholds([0, 0])).toEqual([]);
  });
});

describe("levelFor — a day of work is never an empty square", () => {
  it("puts the smallest possible day on level 1, not 0", () => {
    expect(levelFor(1, bucketThresholds([1, 500, 5000]))).toBe(1);
  });

  it("reserves level 0 for genuinely no activity", () => {
    expect(levelFor(0, [10, 20, 30])).toBe(0);
  });

  it("caps at 4 however many cuts it is given", () => {
    expect(levelFor(9999, [1, 2, 3])).toBe(4);
  });

  it("works with a single cut (a very short history)", () => {
    expect(levelFor(10, [50])).toBe(1);
    expect(levelFor(90, [50])).toBe(2);
  });
});

describe("shouldShowCalendar — never render an empty year", () => {
  it("is false while history is one or two days", () => {
    expect(shouldShowCalendar([day("2026-08-24", 300)])).toBe(false);
    expect(
      shouldShowCalendar([day("2026-08-23", 300), day("2026-08-24", 40)]),
    ).toBe(false);
  });

  it("is true once there are enough active days", () => {
    const rows = Array.from({ length: MIN_DAYS_FOR_CALENDAR }, (_, i) =>
      day(`2026-08-${String(i + 1).padStart(2, "0")}`, 50),
    );
    expect(shouldShowCalendar(rows)).toBe(true);
  });

  it("does not count zero-activity rows toward the threshold", () => {
    const rows = Array.from({ length: MIN_DAYS_FOR_CALENDAR }, (_, i) =>
      day(`2026-08-${String(i + 1).padStart(2, "0")}`, 0, 0, 0),
    );
    expect(shouldShowCalendar(rows)).toBe(false);
  });
});

describe("buildCalendarGrid — shape and alignment", () => {
  // A Monday, so the padding either side is non-trivial.
  const today = new Date(2026, 7, 24);

  it("is a whole number of Sunday→Saturday columns", () => {
    const grid = buildCalendarGrid([day("2026-08-01", 100)], today);
    expect(grid.weeks.every((w) => w.length === 7)).toBe(true);
    for (const week of grid.weeks) {
      expect(parseLocalDay(week[0]!.day).getDay()).toBe(0); // Sunday
      expect(parseLocalDay(week[6]!.day).getDay()).toBe(6); // Saturday
    }
  });

  it("floors to a sensible width on a very short history", () => {
    const grid = buildCalendarGrid([day("2026-08-24", 100)], today);
    expect(grid.weeks).toHaveLength(MIN_CALENDAR_WEEKS);
  });

  it("grows with history instead of always spanning a year", () => {
    // Twenty weeks of history: wider than the floor, far short of the cap.
    const grid = buildCalendarGrid([day("2026-04-06", 100)], today);
    expect(grid.weeks.length).toBeGreaterThan(MIN_CALENDAR_WEEKS);
    expect(grid.weeks.length).toBeLessThan(MAX_CALENDAR_WEEKS);
  });

  it("caps at a year once history is longer than that", () => {
    const grid = buildCalendarGrid([day("2019-01-01", 100)], today);
    expect(grid.weeks).toHaveLength(MAX_CALENDAR_WEEKS);
  });

  it("lands each day's numbers on that day's square", () => {
    const grid = buildCalendarGrid(
      [day("2026-08-20", 300, 25, 4), day("2026-08-21", 10)],
      today,
    );
    const cells = grid.weeks.flat();
    const hit = cells.find((c) => c.day === "2026-08-20")!;
    expect(hit.linesAdded).toBe(300);
    expect(hit.linesRemoved).toBe(25);
    expect(hit.edits).toBe(4);
    expect(hit.level).toBeGreaterThan(0);
  });

  it("marks days after today as out of range, not as zero days", () => {
    // The final column runs to Saturday, so a Monday 'today' leaves five future
    // squares that must not read as days with no work.
    const grid = buildCalendarGrid([day("2026-08-24", 100)], today);
    const future = grid.weeks.flat().filter((c) => c.day > "2026-08-24");
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((c) => !c.inRange)).toBe(true);
    const past = grid.weeks.flat().filter((c) => c.day <= "2026-08-24");
    expect(past.every((c) => c.inRange)).toBe(true);
  });

  it("labels a month only where it changes", () => {
    const grid = buildCalendarGrid([day("2026-04-06", 100)], today);
    const labelled = grid.monthLabels.filter((m) => m != null);
    // One label per month spanned, not one per column.
    expect(labelled.length).toBeLessThan(grid.monthLabels.length);
    expect(labelled.length).toBeGreaterThan(1);
  });

  it("handles an empty history without throwing", () => {
    const grid = buildCalendarGrid([], today);
    expect(grid.weeks).toHaveLength(MIN_CALENDAR_WEEKS);
    expect(grid.weeks.flat().every((c) => c.level === 0)).toBe(true);
    expect(grid.thresholds).toEqual([]);
  });
});

describe("local day handling", () => {
  it("round-trips a local day key without shifting", () => {
    // The bug this avoids: `new Date("2026-08-24")` is UTC midnight, which is the
    // 23rd for anyone west of Greenwich — squares would land on the wrong day.
    const key = "2026-08-24";
    expect(localDayString(parseLocalDay(key))).toBe(key);
  });

  it("keys an evening as its own local day", () => {
    expect(localDayString(new Date(2026, 7, 24, 23, 30))).toBe("2026-08-24");
  });
});

describe("describeCalendarCell — one sentence for tooltip and screen reader", () => {
  const grid = buildCalendarGrid(
    [day("2026-08-20", 300, 25, 4)],
    new Date(2026, 7, 24),
  );
  const cells = grid.weeks.flat();

  it("names the counts on an active day", () => {
    const text = describeCalendarCell(
      cells.find((c) => c.day === "2026-08-20")!,
    );
    expect(text).toContain("300");
    expect(text).toContain("25");
    expect(text).toContain("4 edits");
  });

  it("says so plainly on a day with nothing", () => {
    const quiet = cells.find((c) => c.inRange && dayTotal(c) === 0)!;
    expect(describeCalendarCell(quiet)).toContain("no changes");
  });

  it("does not claim 'no changes' for a day that has not happened", () => {
    const future = cells.find((c) => !c.inRange);
    if (future)
      expect(describeCalendarCell(future)).not.toContain("no changes");
  });

  it("uses the singular for a single edit", () => {
    const one = buildCalendarGrid(
      [day("2026-08-20", 5, 0, 1)],
      new Date(2026, 7, 24),
    )
      .weeks.flat()
      .find((c) => c.day === "2026-08-20")!;
    expect(describeCalendarCell(one)).toContain("1 edit");
    expect(describeCalendarCell(one)).not.toContain("1 edits");
  });
});
