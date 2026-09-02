/**
 * The sideways tab strip.
 *
 * THE PROBLEM IT REPLACES: `flex flex-wrap`. With eight sections, "Danger zone"
 * wrapped onto a row of its own — one item on a second line, which reads as a
 * separate group rather than the last tab, and made the strip's height depend on
 * the window width so content below moved on resize.
 *
 * What actually needs pinning is the ARROW LOGIC, because an always-visible
 * arrow that sometimes does nothing and a hidden overflow with no affordance are
 * both worse than wrapping. jsdom reports every element as zero-size, so
 * scrollWidth/clientWidth are stubbed per case — the geometry is the input here,
 * not the thing under test.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * The arrows are queried by `aria-label` rather than by ROLE, deliberately: a
 * hidden arrow carries `aria-hidden="true"`, which removes it from the
 * accessibility tree — so `getByRole` cannot see it, and that is the component
 * working correctly, not a test problem.
 */
function arrow(dir: "left" | "right", label = "Settings"): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[aria-label="Scroll ${label} ${dir}"]`,
  );
  if (!el) throw new Error(`no ${dir} arrow for "${label}"`);
  return el;
}
import { ScrollableTabNav } from "@/components/ScrollableTabNav";

/** Force a strip geometry, the way a real browser would report it. */
function setGeometry(opts: { scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  const strip = screen.getByRole("navigation");
  Object.defineProperty(strip, "scrollWidth", { value: opts.scrollWidth, configurable: true });
  Object.defineProperty(strip, "clientWidth", { value: opts.clientWidth, configurable: true });
  Object.defineProperty(strip, "scrollLeft", {
    value: opts.scrollLeft ?? 0,
    writable: true,
    configurable: true,
  });
  fireEvent.scroll(strip);
  return strip;
}

const TABS = (
  <>
    <a href="#a" aria-current="page">General</a>
    <a href="#b">Diagnostics</a>
    <a href="#c">Danger zone</a>
  </>
);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("ScrollableTabNav", () => {
  it("keeps every tab on ONE row", () => {
    render(<ScrollableTabNav label="Settings">{TABS}</ScrollableTabNav>);
    const strip = screen.getByRole("navigation");
    // The wrap is what put "Danger zone" on a line of its own.
    expect(strip.className).not.toContain("flex-wrap");
    expect(strip.className).toContain("overflow-x-auto");
    expect(screen.getByText("Danger zone")).toBeTruthy();
  });

  it("hides BOTH arrows when nothing overflows", () => {
    // The common case: it must behave exactly like the old single-row nav, with
    // no dead controls sitting in the row.
    render(<ScrollableTabNav label="Settings">{TABS}</ScrollableTabNav>);
    setGeometry({ scrollWidth: 400, clientWidth: 400 });
    for (const dir of ["left", "right"] as const) {
      expect(arrow(dir).className, dir).toContain("invisible");
    }
  });

  it("shows only the RIGHT arrow at the start of an overflowing strip", () => {
    render(<ScrollableTabNav label="Settings">{TABS}</ScrollableTabNav>);
    setGeometry({ scrollWidth: 900, clientWidth: 400, scrollLeft: 0 });
    expect(
      arrow("left").className,
    ).toContain("invisible");
    expect(
      arrow("right").className,
    ).not.toContain("invisible");
  });

  it("shows only the LEFT arrow at the end", () => {
    render(<ScrollableTabNav label="Settings">{TABS}</ScrollableTabNav>);
    setGeometry({ scrollWidth: 900, clientWidth: 400, scrollLeft: 500 });
    expect(
      arrow("left").className,
    ).not.toContain("invisible");
    expect(
      arrow("right").className,
    ).toContain("invisible");
  });

  it("shows both arrows in the middle", () => {
    render(<ScrollableTabNav label="Settings">{TABS}</ScrollableTabNav>);
    setGeometry({ scrollWidth: 900, clientWidth: 400, scrollLeft: 250 });
    for (const dir of ["left", "right"] as const) {
      expect(arrow(dir).className, dir).not.toContain("invisible");
    }
  });

  it("tolerates sub-pixel rounding rather than arming a dead arrow", () => {
    // scrollWidth can exceed clientWidth by a fraction with no real overflow.
    render(<ScrollableTabNav label="Settings">{TABS}</ScrollableTabNav>);
    setGeometry({ scrollWidth: 401, clientWidth: 400 });
    expect(
      arrow("right").className,
    ).toContain("invisible");
  });

  it("takes a hidden arrow out of the tab order", () => {
    // Disabled would keep it focusable and clickable-looking; invisible plus
    // tabIndex -1 keeps it out of the way entirely.
    render(<ScrollableTabNav label="Settings">{TABS}</ScrollableTabNav>);
    setGeometry({ scrollWidth: 400, clientWidth: 400 });
    const left = arrow("left");
    expect(left.getAttribute("tabindex")).toBe("-1");
    expect(left.getAttribute("aria-hidden")).toBe("true");
  });

  it("names the arrows after the strip, for screen readers", () => {
    render(<ScrollableTabNav label="Integrations">{TABS}</ScrollableTabNav>);
    setGeometry({ scrollWidth: 900, clientWidth: 400, scrollLeft: 250 });
    expect(arrow("left", "Integrations")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Integrations" })).toBeTruthy();
  });

  it("scrolls by most of a screenful, not all of it", () => {
    // A tab straddling the edge should stay partly visible, so the strip's
    // continuity is obvious rather than jumping to a fresh-looking set.
    render(<ScrollableTabNav label="Settings">{TABS}</ScrollableTabNav>);
    const strip = setGeometry({ scrollWidth: 900, clientWidth: 400, scrollLeft: 0 });
    let scrolledBy: number | undefined;
    strip.scrollBy = ((opts: ScrollToOptions) => {
      scrolledBy = opts.left;
    }) as typeof strip.scrollBy;
    fireEvent.click(arrow("right"));
    expect(scrolledBy).toBe(320); // 400 * 0.8
  });
});
