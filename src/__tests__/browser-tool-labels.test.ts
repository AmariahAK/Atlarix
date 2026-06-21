/**
 * Browser/preview tool cards must read as concrete, correctly-tensed actions
 * (no more "Runned browser inspect"; the generic "Done" body is replaced by a
 * human note in the tool result). Covers browserToolLabel + getToolDoneLabel.
 */
import { describe, it, expect } from "vitest";
import {
  browserToolLabel,
  getToolDoneLabel,
  getToolActivityLabelWithArgs,
} from "@/lib/tool-activity-labels";

describe("browserToolLabel", () => {
  it("never produces the broken 'Runned' fallback", () => {
    // Regression: with no label-map entry the old fallback made "Runned …".
    expect(getToolDoneLabel("browser_inspect")).not.toMatch(/runned/i);
    expect(getToolDoneLabel("browser_inspect")).toBe("Inspected page");
    expect(getToolDoneLabel("browser_navigate")).toBe("Opened page");
    expect(getToolDoneLabel("browser_interact")).toBe("Acted on page");
  });

  it("interact fill reads as 'Filled \"…\"' with preview suffix", () => {
    expect(
      getToolDoneLabel("browser_interact", {
        action: "fill",
        value: "user@example.com",
        target: "preview",
      }),
    ).toBe('Filled "user@example.com" · preview');
    expect(
      getToolActivityLabelWithArgs("browser_interact", {
        action: "fill",
        value: "hello",
      }),
    ).toBe('Filling "hello"…');
  });

  it("interact click reads as 'Clicked …' and respects target", () => {
    expect(
      getToolDoneLabel("browser_interact", { action: "click", ref: "e11", target: "preview" }),
    ).toBe("Clicked e11 · preview");
    expect(
      getToolDoneLabel("browser_interact", { action: "click", selector: ".btn" }),
    ).toBe("Clicked .btn");
  });

  it("inspect mode + target shape the label", () => {
    expect(getToolDoneLabel("browser_inspect", { mode: "snapshot", target: "preview" })).toBe(
      "Inspected preview",
    );
    expect(getToolDoneLabel("browser_inspect", { mode: "console", target: "preview" })).toBe(
      "Read preview console",
    );
    expect(getToolActivityLabelWithArgs("browser_inspect", { mode: "text" })).toBe(
      "Reading page text…",
    );
  });

  it("navigate shows the host/path and preview target", () => {
    expect(
      getToolDoneLabel("browser_navigate", { url: "http://localhost:3000/auth/register" }),
    ).toBe("Opened localhost:3000/auth/register");
    expect(getToolDoneLabel("browser_navigate", { target: "preview" })).toBe("Opened preview");
  });

  it("returns null for non-browser tools (so other labels are untouched)", () => {
    expect(browserToolLabel("read_file", { path: "a.ts" }, "done")).toBeNull();
    expect(getToolDoneLabel("read_file")).toBe("Read files");
  });
});
