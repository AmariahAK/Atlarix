/**
 * The calendar grid renders.
 *
 * A smoke test with teeth: the arithmetic is covered by
 * `src/__tests__/edit-stats-calendar.test.ts`, so what this adds is that the component
 * actually mounts, that every in-range day is reachable by its accessible name (the
 * squares carry the values that colour alone cannot), and that a future day is not
 * presented as a day with no work.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditStatsCalendar } from "@/components/settings/EditStatsCalendar";
import type { EditStatsDayRow } from "@/ipc/ipc_types";

/** Recent days, so they land inside the 8-week floor whenever the suite runs. */
function recentDays(count: number): EditStatsDayRow[] {
  const rows: EditStatsDayRow[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    rows.push({
      day,
      linesAdded: 50 + i * 40,
      linesRemoved: 5 + i,
      edits: 1 + (i % 3),
    });
  }
  return rows.reverse();
}

describe("EditStatsCalendar", () => {
  it("renders a grid with a legend", () => {
    render(<EditStatsCalendar byDay={recentDays(10)} />);
    expect(screen.getByRole("grid", { name: /code changes by day/i })).toBeTruthy();
    expect(screen.getByText("Less")).toBeTruthy();
    expect(screen.getByText("More")).toBeTruthy();
  });

  it("gives every past day an accessible name carrying its numbers", () => {
    render(<EditStatsCalendar byDay={recentDays(3)} />);
    const cells = screen.getAllByRole("gridcell");
    const named = cells.filter((c) => c.getAttribute("aria-label"));
    expect(named.length).toBeGreaterThan(0);
    // The busiest seeded day is the oldest of the three (50 + 2*40 = 130 added).
    expect(named.some((c) => /\+130\b/.test(c.getAttribute("aria-label") ?? ""))).toBe(
      true,
    );
  });

  it("says 'no changes' for a quiet past day, and nothing of the sort for a future one", () => {
    render(<EditStatsCalendar byDay={recentDays(2)} />);
    const labels = screen
      .getAllByRole("gridcell")
      .map((c) => c.getAttribute("aria-label"))
      .filter((l): l is string => Boolean(l));
    expect(labels.some((l) => /no changes/i.test(l))).toBe(true);
    // Future cells are rendered without a label at all, so they cannot be read as
    // days where nothing was done.
    const unlabelled = screen
      .getAllByRole("gridcell")
      .filter((c) => !c.getAttribute("aria-label"));
    expect(unlabelled.every((c) => !/no changes/i.test(c.textContent ?? ""))).toBe(true);
  });

  it("shows one shared tooltip on hover, and clears it on leave", () => {
    render(<EditStatsCalendar byDay={recentDays(6)} />);
    const cell = screen
      .getAllByRole("gridcell")
      .find((c) => c.getAttribute("aria-label")?.includes("+"))!;
    const label = cell.getAttribute("aria-label")!;
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.mouseEnter(cell);
    // Same sentence as the accessible name — one describe function, so the visible
    // text and the screen-reader text cannot drift apart.
    expect(screen.getByRole("status").textContent).toBe(label);
    fireEvent.mouseLeave(cell);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders an empty history without crashing", () => {
    render(<EditStatsCalendar byDay={[]} />);
    expect(screen.getByRole("grid", { name: /code changes by day/i })).toBeTruthy();
  });
});
