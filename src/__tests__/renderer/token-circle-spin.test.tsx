/**
 * The context ring must not try to animate a moving target while a turn streams.
 *
 * THE REPORTED SYMPTOM: "the circle doesn't fully spin, it glitches out until the AI
 * is done generating." It was never a spinner — it is a usage gauge, and `used` comes
 * from live provider usage that updates many times a second. Every update restarted
 * the 0.3s `stroke-dashoffset` transition, so it never completed and the arc jumped.
 *
 * The fix has to be structural, not a tuned duration: while streaming the arc is a
 * CONSTANT length turned by a CSS keyframe, so smoothness no longer depends on render
 * frequency at all. These assertions pin the two properties that make that true —
 * a fixed dasharray, and no dashoffset transition to interrupt.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TokenCircle } from "@/components/chat/TokenCircle";

/** The progress arc is the second circle; the first is the track. */
function arcOf(container: HTMLElement): SVGCircleElement {
  const circles = container.querySelectorAll("circle");
  return circles[1] as SVGCircleElement;
}
const svgOf = (c: HTMLElement) => c.querySelector("svg")!;

describe("TokenCircle while streaming", () => {
  it("spins with a CSS keyframe, not a value transition", () => {
    const { container } = render(
      <TokenCircle used={1000} total={100_000} spin />,
    );
    // Compositor-driven: immune to how often React re-renders, which is the whole point.
    expect(svgOf(container).getAttribute("class")).toContain("animate-spin");
  });

  it("holds a CONSTANT arc, so a new token count cannot move it", () => {
    // The decisive property. Re-render with a very different `used` and the arc
    // geometry must be identical — nothing to animate means nothing to stutter.
    const { container, rerender } = render(
      <TokenCircle used={1_000} total={100_000} spin />,
    );
    const before = arcOf(container).getAttribute("stroke-dasharray");
    rerender(<TokenCircle used={90_000} total={100_000} spin />);
    const after = arcOf(container).getAttribute("stroke-dasharray");

    expect(before).toBe(after);
    expect(arcOf(container).getAttribute("stroke-dashoffset")).toBe("0");
  });

  it("carries no dashoffset transition to be interrupted", () => {
    const { container } = render(
      <TokenCircle used={1000} total={100_000} spin />,
    );
    expect(arcOf(container).getAttribute("style") ?? "").not.toContain(
      "stroke-dashoffset",
    );
  });

  it("lets the spin win over the compaction pulse", () => {
    // Both set `animation`, so they cannot coexist — and compaction runs DURING a
    // stream, so honouring pulse here would restore the jitter for the whole window
    // that actually matters.
    const { container } = render(
      <TokenCircle used={1000} total={100_000} spin pulse />,
    );
    const cls = svgOf(container).getAttribute("class") ?? "";
    expect(cls).toContain("animate-spin");
    expect(cls).not.toContain("animate-pulse");
  });
});

describe("TokenCircle when idle", () => {
  it("still reports usage as a proportional arc", () => {
    // The gauge must be unchanged when nothing is streaming — the spin is an
    // additional mode, not a replacement for what this component is for.
    const { container } = render(<TokenCircle used={50_000} total={100_000} />);
    const arc = arcOf(container);
    const dasharray = Number(arc.getAttribute("stroke-dasharray"));
    const offset = Number(arc.getAttribute("stroke-dashoffset"));

    expect(svgOf(container).getAttribute("class")).not.toContain(
      "animate-spin",
    );
    // Half used → half the circumference still to go.
    expect(offset).toBeCloseTo(dasharray / 2, 5);
    expect(arc.getAttribute("style") ?? "").toContain("stroke-dashoffset");
  });

  it("keeps the pulse available for compaction", () => {
    const { container } = render(
      <TokenCircle used={1000} total={100_000} pulse />,
    );
    expect(svgOf(container).getAttribute("class")).toContain("animate-pulse");
  });
});
