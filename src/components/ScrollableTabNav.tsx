/**
 * A one-line tab strip that scrolls sideways, with the arrows a spreadsheet's
 * sheet tabs use.
 *
 * WHY NOT `flex-wrap`. That is what Settings and Integrations both had, and with
 * eight sections the last one ("Danger zone") wrapped onto a row of its own — a
 * second line carrying one item, which reads as a separate group rather than the
 * last tab. Wrapping also makes the strip's height depend on the window width,
 * so the content below moves when you resize.
 *
 * One row is honest about what this is: a list of siblings, in order. And it
 * scales — the next section added does not cost a line of vertical space.
 *
 * THE ARROWS ARE CONDITIONAL, and that is the point of them. A strip that
 * overflows with no affordance is the actual failure here (content the user
 * cannot see and has no reason to look for), and an arrow that is always
 * present but sometimes inert is its own small lie. Each side renders only when
 * there is something in that direction.
 *
 * Rendering is `children`, not a config array: the two call sites build typed
 * TanStack `Link`s, and taking a `to`/`label` list here would either lose that
 * typing or force this component to know about routing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  /** For the landmark's accessible name — "Settings", "Integrations". */
  label: string;
  className?: string;
  children: React.ReactNode;
};

/** A hair of slack, so a sub-pixel layout rounding does not arm a dead arrow. */
const EDGE_SLOP = 2;

export function ScrollableTabNav({ label, className, children }: Props) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setAtStart(el.scrollLeft <= EDGE_SLOP);
    // `max <= EDGE_SLOP` covers the common case: nothing overflows, so BOTH
    // arrows stay hidden and this behaves exactly like the old single-row nav.
    setAtEnd(max <= EDGE_SLOP || el.scrollLeft >= max - EDGE_SLOP);
  }, []);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    measure();
    // Overflow changes with the WINDOW, not just with the tabs, so a resize
    // observer is the only thing that keeps the arrows honest. Falls back to
    // one measurement where ResizeObserver is unavailable (jsdom, older hosts).
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);

  /**
   * Bring the active tab into view on mount and on navigation.
   *
   * Without this, deep-linking to the last section shows a strip scrolled to the
   * start with the active tab off-screen — the same "content you cannot see"
   * problem, arrived at from the other direction.
   */
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const active = el.querySelector('[aria-current="page"]');
    if (active && "scrollIntoView" in active) {
      (active as HTMLElement).scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
    measure();
  }, [children, measure]);

  const nudge = (dir: -1 | 1) => {
    const el = strip.current;
    if (!el) return;
    // Most of a screenful, not all of it: a tab straddling the edge should stay
    // partly visible so the strip's continuity is obvious.
    el.scrollBy({
      left: dir * Math.max(160, el.clientWidth * 0.8),
      behavior: "smooth",
    });
  };

  const arrow = (dir: -1 | 1, hidden: boolean) => {
    const Icon = dir === -1 ? ChevronLeft : ChevronRight;
    return (
      <button
        type="button"
        // Hidden rather than disabled: a disabled control still occupies the row
        // and invites a click. `aria-hidden` + `tabIndex={-1}` keeps it out of
        // the tab order when it cannot do anything.
        className={cn(
          "shrink-0 rounded-lg border border-border p-1.5 text-muted-foreground transition-colors",
          "hover:text-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          hidden && "invisible pointer-events-none",
        )}
        onClick={() => nudge(dir)}
        aria-label={
          dir === -1 ? `Scroll ${label} left` : `Scroll ${label} right`
        }
        aria-hidden={hidden || undefined}
        tabIndex={hidden ? -1 : 0}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </button>
    );
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {arrow(-1, atStart)}
      <nav
        aria-label={label}
        ref={strip}
        onScroll={measure}
        // `scrollbar-none` hides the bar; the arrows and the overflow shadow are
        // the affordance. Keyboard scrolling still works, and the strip is still
        // reachable by wheel/trackpad.
        className="flex-1 flex items-center gap-2 overflow-x-auto scrollbar-none scroll-smooth"
      >
        {children}
      </nav>
      {arrow(1, atEnd)}
    </div>
  );
}
