import { useMemo, useState } from "react";
import {
  buildCalendarGrid,
  describeCalendarCell,
  type CalendarCell,
} from "@/lib/stats/edit-stats-calendar";
import type { EditStatsDayRow } from "@/ipc/ipc_types";
import { cn } from "@/lib/utils";

/**
 * Contribution calendar for code changes.
 *
 * Plain CSS grid, no charting dependency: this is squares and a colour scale, and a
 * chart library for it would be surface with no capability behind it.
 *
 * ONE shared tooltip, positioned from the hovered cell, rather than a tooltip
 * component per square — a year is ~370 cells, and 370 Radix roots (each of which
 * mounts its own provider) is a real cost for something a single positioned element
 * does. Every cell still carries an `aria-label`, so the values are reachable without
 * hovering or seeing colour at all.
 */

/** Level → token. Indexed, so the ramp lives in CSS and this stays layout-only. */
const LEVEL_BG = [
  "bg-(--calendar-0)",
  "bg-(--calendar-1)",
  "bg-(--calendar-2)",
  "bg-(--calendar-3)",
  "bg-(--calendar-4)",
] as const;

/** Rows Sunday→Saturday; only alternate labels, as GitHub does, to avoid a wall of text. */
const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""] as const;

type HoverState = { text: string; x: number; y: number } | null;

export function EditStatsCalendar({
  byDay,
  className = "",
}: {
  byDay: EditStatsDayRow[];
  className?: string;
}) {
  // `new Date()` is read once per data change rather than per render, so cells do not
  // silently re-bucket mid-session.
  const grid = useMemo(() => buildCalendarGrid(byDay), [byDay]);
  const [hover, setHover] = useState<HoverState>(null);

  const show = (cell: CalendarCell, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setHover({
      text: describeCalendarCell(cell),
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  };

  return (
    <div className={cn("relative", className)}>
      {/* Wide grids scroll inside their own container rather than stretching the card. */}
      <div className="overflow-x-auto pb-1">
        <div className="inline-flex gap-1">
          {/* Weekday gutter. aria-hidden: the per-cell labels already name the date, so
              these would only add noise to a screen reader. */}
          <div
            className="grid grid-rows-7 gap-[3px] pr-1 pt-[18px]"
            aria-hidden="true"
          >
            {WEEKDAY_LABELS.map((label, i) => (
              <div
                key={i}
                className="text-muted-foreground h-[11px] text-[9px] leading-[11px]"
              >
                {label}
              </div>
            ))}
          </div>

          <div>
            {/* Month labels, one per column but rendered only where the month turns. */}
            <div className="flex gap-[3px]" aria-hidden="true">
              {grid.monthLabels.map((label, i) => (
                <div
                  key={i}
                  className="text-muted-foreground w-[11px] text-[9px] leading-[18px] whitespace-nowrap"
                >
                  {label}
                </div>
              ))}
            </div>

            <div
              className="flex gap-[3px]"
              role="grid"
              aria-label="Code changes by day"
            >
              {grid.weeks.map((week, wi) => (
                <div key={wi} className="grid grid-rows-7 gap-[3px]" role="row">
                  {week.map((cell) =>
                    cell.inRange ? (
                      <div
                        key={cell.day}
                        role="gridcell"
                        tabIndex={-1}
                        aria-label={describeCalendarCell(cell)}
                        className={cn(
                          "h-[11px] w-[11px] rounded-[2px]",
                          LEVEL_BG[cell.level],
                          "hover:ring-primary/60 hover:ring-1",
                        )}
                        onMouseEnter={(e) => show(cell, e.currentTarget)}
                        onMouseLeave={() => setHover(null)}
                        onFocus={(e) => show(cell, e.currentTarget)}
                        onBlur={() => setHover(null)}
                      />
                    ) : (
                      // A day that has not happened yet. Blank, not level 0 — an
                      // empty square would claim no work was done on a future day.
                      <div
                        key={cell.day}
                        role="gridcell"
                        className="h-[11px] w-[11px]"
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Legend. Present even though there is one series: the ramp's low end sits
          deliberately close to the surface, so the reader needs to be told that pale
          means less rather than left to guess. */}
      <div className="text-muted-foreground mt-2 flex items-center justify-end gap-1 text-[10px]">
        <span>Less</span>
        {LEVEL_BG.map((bg, i) => (
          <span key={i} className={cn("h-[11px] w-[11px] rounded-[2px]", bg)} />
        ))}
        <span>More</span>
      </div>

      {hover ? (
        <div
          // `fixed` + viewport coordinates, so the card's own overflow/scroll cannot
          // clip the tooltip at the grid's edges.
          className="bg-popover text-popover-foreground pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md border px-2 py-1 text-xs shadow-md"
          style={{ left: hover.x, top: hover.y - 6 }}
          role="status"
        >
          {hover.text}
        </div>
      ) : null}
    </div>
  );
}
