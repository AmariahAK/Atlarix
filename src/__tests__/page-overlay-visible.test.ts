/**
 * The "Atlarix is using this tab" frame must actually be VISIBLE.
 *
 * ══ THE BUG THIS PINS ══
 *
 * The frame is appended at `opacity: 0` and faded in from a
 * `requestAnimationFrame` callback. **rAF does not fire in a background tab** —
 * and the desktop bridge opens every tab it works in with `active: false`. So
 * the element was created, the op returned `{ok: true}`, the desktop reported
 * success, and the user saw nothing at all. Every layer agreed it had worked.
 *
 * That is why these assert the rendered OPACITY rather than the element's
 * existence: a test for `getElementById(...) !== null` passes against the bug.
 */
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { atlarixPageKernel, type PageRequest } from "@/lib/browser/page-scripts";

/**
 * Run the kernel with rAF and setTimeout INJECTED, so a test can withhold them.
 * Passed as parameters rather than set on the global: the kernel is stringified
 * and reads them as bare globals, and node has no `requestAnimationFrame` at
 * all — so without this the whole overlay branch would throw into its own
 * try/catch and the test would pass for the wrong reason.
 */
function runKernel(
  dom: JSDOM,
  req: PageRequest,
  opts: { raf: boolean } = { raf: true },
) {
  const { window } = dom;
  const timers: (() => void)[] = [];
  const run = new Function(
    "document",
    "location",
    "URL",
    "window",
    "requestAnimationFrame",
    "setTimeout",
    `return (${atlarixPageKernel.toString()})(${JSON.stringify(req)})`,
  );
  const result = run(
    window.document,
    window.location,
    window.URL,
    window,
    // A BACKGROUND TAB: the callback is accepted and never invoked.
    opts.raf ? (cb: () => void) => cb() : () => {},
    (cb: () => void) => {
      timers.push(cb);
      return 0;
    },
  );
  return { result, flushTimers: () => timers.splice(0).forEach((t) => t()) };
}

const FRAME = "#__atlarix_ai_frame__";

describe("the driving indicator", () => {
  it("becomes visible in a FOREGROUND tab", () => {
    const dom = new JSDOM("<body><p>page</p></body>");
    const { flushTimers } = runKernel(dom, { op: "overlay", state: "on" });
    flushTimers();
    const frame = dom.window.document.querySelector(FRAME) as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.opacity).toBe("1");
  });

  it("becomes visible in a BACKGROUND tab, where rAF never fires", () => {
    const dom = new JSDOM("<body><p>page</p></body>");
    const { flushTimers } = runKernel(
      dom,
      { op: "overlay", state: "on" },
      { raf: false },
    );
    const frame = dom.window.document.querySelector(FRAME) as HTMLElement;
    // Before the timer: this is exactly the state the owner saw — in the DOM,
    // invisible on screen, and reported as a success everywhere.
    expect(frame).not.toBeNull();
    expect(frame.style.opacity).toBe("0");

    flushTimers();
    expect(frame.style.opacity).toBe("1");
  });

  it("carries a label a person can read", () => {
    const dom = new JSDOM("<body></body>");
    runKernel(dom, { op: "overlay", state: "on" });
    const label = dom.window.document.querySelector(
      `${FRAME} [data-part="frame-label"]`,
    );
    expect(label?.textContent).toContain("Atlarix");
  });

  it("takes itself down, and takes the cursor with it", () => {
    const dom = new JSDOM("<body></body>");
    runKernel(dom, { op: "overlay", state: "on" });
    // A cursor left resting after the agent stopped is the same lie as a
    // border left up, so `off` must clear both.
    const cursor = dom.window.document.createElement("div");
    cursor.id = "__atlarix_ai_cursor__";
    dom.window.document.body.appendChild(cursor);

    runKernel(dom, { op: "overlay", state: "off" });
    expect(dom.window.document.querySelector(FRAME)).toBeNull();
    expect(
      dom.window.document.getElementById("__atlarix_ai_cursor__"),
    ).toBeNull();
  });
});
