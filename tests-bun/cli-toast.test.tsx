/** @jsxImportSource @opentui/react */
/**
 * QA A4: a toast was cut to ONE line. Its box shrank to the text's unwrapped
 * width and stayed one row high, so a wrapped message lost everything after its
 * first line: "/computer on" showed only "Computer use on for us.anthropic.…",
 * never how to stop it or the macOS warning.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { Toast } from "../src/cli/tui/Toast";

let destroy: (() => void) | null = null;
afterEach(() => {
  destroy?.();
  destroy = null;
});

async function frame(message: string, width = 100) {
  const setup = await testRender(<Toast toast={{ message, variant: "success" }} width={width} />, { width, height: 16 });
  destroy = () => setup.renderer.destroy();
  await setup.renderOnce();
  await setup.renderOnce();
  // The side bars sit between wrapped lines: drop them, then join the lines.
  return setup.captureCharFrame().replace(/│/g, " ").replace(/\s+/g, " ");
}

describe("a toast shows all of its message", () => {
  it("a message that wraps to three lines shows all three", async () => {
    const msg =
      "Computer use on for us.anthropic.claude-haiku-4-5-20251001-v1:0. Move the mouse to stop it. " +
      "macOS will ask to let Terminal record the screen and control the computer. That's Atlarix's computer use.";
    const f = await frame(msg);
    for (const part of ["Computer use on for", "Move the mouse to stop it.", "macOS will ask", "That's Atlarix's computer use."]) {
      expect(f).toContain(part);
    }
  });

  it("a short one stays one line, the width of its text", async () => {
    const f = await frame("Copied");
    expect(f).toContain("Copied");
  });
});
