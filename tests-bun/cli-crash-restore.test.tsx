/** @jsxImportSource @opentui/react */
/**
 * A crash inside the TUI gives the terminal back BEFORE anything is printed:
 * the renderer (alternate screen, raw mode, hidden cursor) is destroyed first,
 * then one plain line is written.
 */
import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { reportFatal, setActiveRenderer } from "../src/cli/tui/run";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

describe("a crash in the TUI", () => {
  it("restores the terminal, then prints one line", async () => {
    const setup = await testRender(<text>hello</text>, { width: 40, height: 5, exitOnCtrlC: false });
    const order: string[] = [];
    const destroy = setup.renderer.destroy.bind(setup.renderer);
    setup.renderer.destroy = () => {
      order.push("restore");
      destroy();
    };
    setActiveRenderer(setup.renderer);
    reportFatal(new Error("something broke"), (s) => order.push(`print:${s.trim().split("\n")[0]}`));
    expect(order).toEqual(["restore", "print:atlarix: something broke"]);
  });

  it("restoring twice is harmless", async () => {
    const setup = await testRender(<text>x</text>, { width: 20, height: 3, exitOnCtrlC: false });
    setActiveRenderer(setup.renderer);
    const lines: string[] = [];
    reportFatal(new Error("a"), (s) => lines.push(s));
    reportFatal(new Error("b"), (s) => lines.push(s));
    expect(lines).toHaveLength(2);
  });
});
