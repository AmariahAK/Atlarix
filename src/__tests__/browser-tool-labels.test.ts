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
    expect(getToolDoneLabel("browser_inspect")).toBe("Read page");
    expect(getToolDoneLabel("browser_navigate")).toBe("Opened page");
    expect(getToolDoneLabel("browser_interact")).toBe("Acted on page");
    expect(getToolDoneLabel("browser_find")).not.toMatch(/runned/i);
    expect(getToolDoneLabel("browser_tabs")).not.toMatch(/runned/i);
    expect(getToolDoneLabel("browser_batch")).not.toMatch(/runned/i);
  });

  it("labels the tab, find and batch tools concretely", () => {
    expect(getToolDoneLabel("browser_find", { query: "login button" })).toBe(
      'Found "login button"',
    );
    expect(getToolDoneLabel("browser_tabs", { operation: "create" })).toBe("Opened a new tab");
    expect(getToolDoneLabel("browser_tabs", { operation: "switch" })).toBe("Switched tab");
    expect(getToolDoneLabel("browser_batch", { steps: [{}, {}] })).toBe(
      "Ran 2 steps in the browser",
    );
  });

  it("labels the new interact verbs", () => {
    expect(getToolDoneLabel("browser_interact", { action: "key", text: "Enter" })).toBe(
      "Pressed Enter",
    );
    expect(getToolDoneLabel("browser_interact", { action: "hover", ref: "e3" })).toBe(
      "Hovered e3",
    );
    expect(getToolDoneLabel("browser_interact", { action: "scroll", direction: "down" })).toBe(
      "Scrolled down",
    );
  });

  it("labels each browser_inspect mode, defaulting to the combined read", () => {
    expect(getToolDoneLabel("browser_inspect", { mode: "visual" })).toBe("Checked page layout");
    expect(getToolDoneLabel("browser_inspect", { mode: "network" })).toBe(
      "Read page network errors",
    );
    expect(getToolDoneLabel("browser_inspect", { mode: "snapshot" })).toBe("Inspected page");
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

describe("the 'Runned' fallback is dead for EVERY tool, not just browser ones", () => {
  /**
   * The old fallback took the generic running label "Running <tool>" and
   * conjugated the first /ing\b/ — which lives inside "Runn·ing" — so any tool
   * missing from the label maps rendered as "Runned <tool>". v14.21's
   * `subagents` tool shipped without an entry and hit exactly that in the
   * packaged app.
   */
  it("gives an unmapped tool a generic past tense instead of mangling the verb", () => {
    expect(getToolDoneLabel("some_new_tool")).toBe("Completed some new tool");
    expect(getToolDoneLabel("some_new_tool")).not.toMatch(/runned/i);
  });

  it("labels the v14.21 sub-agent tools concretely", () => {
    expect(getToolDoneLabel("subagents")).toBe("Checked sub-agents");
    expect(getToolDoneLabel("proposals")).toBe("Reviewed proposed changes");
    expect(getToolDoneLabel("subagents")).not.toMatch(/runned/i);
    expect(getToolDoneLabel("proposals")).not.toMatch(/runned/i);
  });

  it("still conjugates a hand-written label correctly", () => {
    // The fix must not flatten the mapped labels into "Completed grep".
    expect(getToolDoneLabel("grep", {})).toBe("Searched code");
    expect(getToolDoneLabel("task")).toBe("Sub-agent finished");
  });
});

describe("grep/glob search labels surface the pattern", () => {
  it("grep running + done include the pattern", () => {
    expect(getToolActivityLabelWithArgs("grep", { pattern: "handleLogin" })).toBe(
      "Searching for handleLogin…",
    );
    expect(getToolDoneLabel("grep", { pattern: "handleLogin" })).toBe(
      "Searched for handleLogin",
    );
  });

  it("grep folds in the include filter", () => {
    expect(
      getToolActivityLabelWithArgs("grep", { pattern: "TODO|FIXME", include: "*.ts" }),
    ).toBe("Searching for TODO|FIXME in *.ts…");
    expect(getToolDoneLabel("grep", { pattern: "TODO|FIXME", include: "*.ts" })).toBe(
      "Searched for TODO|FIXME in *.ts",
    );
  });

  it("glob running + done include the pattern", () => {
    expect(getToolActivityLabelWithArgs("glob", { pattern: "**/*.tsx" })).toBe(
      "Finding files **/*.tsx…",
    );
    expect(getToolDoneLabel("glob", { pattern: "**/*.tsx" })).toBe(
      "Found files matching **/*.tsx",
    );
  });

  it("grep's search-root path never masks the pattern subject", () => {
    // grep may receive a `path` (search root); the pattern must still win.
    expect(getToolDoneLabel("grep", { pattern: "foo", path: "src/lib" })).toBe(
      "Searched for foo",
    );
  });

  it("falls back to the static label when no pattern is present", () => {
    expect(getToolDoneLabel("grep", {})).toBe("Searched code");
    expect(getToolDoneLabel("glob", {})).toBe("Found files");
    expect(getToolActivityLabelWithArgs("grep", {})).toBe("Searching code…");
  });

  it("clamps very long patterns", () => {
    const long = "x".repeat(80);
    const done = getToolDoneLabel("grep", { pattern: long });
    expect(done.startsWith("Searched for ")).toBe(true);
    expect(done).toContain("…");
    expect(done.length).toBeLessThan("Searched for ".length + 45);
  });
});

describe("tool_help names the tool it read", () => {
  it("running and done labels both carry the subject", () => {
    // "Read tool usage" was the same row for every reveal in a turn.
    expect(getToolActivityLabelWithArgs("tool_help", { tool: "browser" })).toBe(
      "Reading browser…",
    );
    expect(getToolDoneLabel("tool_help", { tool: "browser" })).toBe(
      "Read browser usage",
    );
  });

  it("falls back to the generic label with no argument", () => {
    expect(getToolDoneLabel("tool_help")).toBe("Read tool usage");
    expect(getToolDoneLabel("tool_help", {})).toBe("Read tool usage");
  });

  it("a subject needs an ARG_VERBS entry to survive", () => {
    // The trap that made the first attempt a no-op: subjectFromArgs computed
    // "browser" correctly and getToolActivityLabelWithArgs discarded it, because
    // the verb lookup came back undefined and there was no fallback. If this
    // regresses, the running label silently reverts to the generic string while
    // the done label keeps working — an inconsistency worth catching.
    expect(getToolActivityLabelWithArgs("tool_help", { tool: "grep" })).toMatch(
      /grep/,
    );
  });
});
