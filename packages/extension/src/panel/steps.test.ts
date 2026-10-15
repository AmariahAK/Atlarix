import { describe, expect, it } from "vitest";
import { summariseSteps, type Step } from "./steps";

const tool = (name: string): Step => ({ kind: "tool", name });
const thought: Step = { kind: "thinking" };

describe("what the collapsed card says", () => {
  it("groups by what it meant, not by tool name", () => {
    // "read_page ×2, find_on_page ×1" is the transcript restated. "Read 2 pages"
    // is what happened.
    expect(
      summariseSteps([tool("read_page"), tool("read_page"), tool("fill")]),
    ).toBe("Read 2 pages, Filled a field");
  });

  it("gets singular and plural right", () => {
    expect(summariseSteps([tool("click")])).toBe("Clicked once");
    expect(summariseSteps([tool("click"), tool("click")])).toBe("Clicked 2 times");
    expect(summariseSteps([tool("fill")])).toBe("Filled a field");
    expect(summariseSteps([tool("fill"), tool("fill")])).toBe("Filled 2 fields");
  });

  it("reads in the order things happened", () => {
    // Not in whatever order a Record decides to enumerate — the line is a
    // narrative, and a narrative out of order is worse than no narrative.
    const line = summariseSteps([tool("open_tab"), tool("read_page")]);
    expect(line.indexOf("Opened")).toBeLessThan(line.indexOf("Read"));
  });

  it("stops naming verbs before the line wraps to three rows", () => {
    const line = summariseSteps([
      tool("read_page"),
      tool("fill"),
      tool("click"),
      tool("scroll"),
      tool("hover"),
    ]);
    expect(line).toMatch(/2 more steps/);
  });

  it("puts thinking after the separator, as an aside", () => {
    // It is not an action. Claude's own line does the same with "· 3 notes".
    expect(summariseSteps([thought, tool("read_page"), thought])).toBe(
      "Read a page · thought 2 times",
    );
  });

  it("describes a turn that only thought", () => {
    expect(summariseSteps([thought])).toBe("Thought for a moment");
  });

  it("leads with the count while the turn is still running", () => {
    // Mid-turn the person wants to know something is happening; afterwards they
    // want to know what happened.
    expect(summariseSteps([tool("read_page")], { running: true })).toBe(
      "Working… · Read a page",
    );
    expect(summariseSteps([], { running: true })).toBe("Working…");
  });

  it("never prints a raw tool identifier at the user", () => {
    // The desktop's "Runned <tool>" trap: a new tool with no entry in the verb
    // map must degrade to a count, not leak its function name into the UI.
    const line = summariseSteps([tool("some_future_tool")]);
    expect(line).not.toContain("some_future_tool");
    expect(line).toBe("1 step");
  });

  it("says something rather than nothing for an empty run", () => {
    expect(summariseSteps([])).toBe("No steps");
  });
});

describe("what does NOT get a card", () => {
  it("describes a single step, for the caller that decides not to wrap it", () => {
    // A card around one thinking block is a click that reveals one thing and a
    // line that repeats what the thing already said. `settleSteps` unwraps a
    // run of one; this is here so the summariser stays honest for the case.
    expect(summariseSteps([tool("read_page")])).toBe("Read a page");
    expect(summariseSteps([thought])).toBe("Thought for a moment");
  });

  it("groups a real run, which is the case the card exists for", () => {
    expect(
      summariseSteps([
        thought,
        tool("read_page"),
        tool("fill"),
        tool("fill"),
        tool("click"),
      ]),
    ).toBe("Read a page, Filled 2 fields, Clicked once · thought once");
  });
});

/**
 * The gap that produced "1 step, 1 step" in a real session.
 *
 * Two different tools with no VERBS entry each rendered their own "1 step"
 * fallback, and the card read like a bug. Both halves are pinned: the table
 * covers every tool that exists, and the fallback aggregates so the NEXT tool
 * added without an entry degrades to an honest count instead.
 */
describe("every tool has a verb", () => {
  it("covers all of TOOL_NAMES", async () => {
    const { TOOL_NAMES } = await import("../tools/schemas");
    const missing = [...TOOL_NAMES].filter(
      (name) => summariseSteps([{ kind: "tool", name }]) === "1 step",
    );
    expect(missing).toEqual([]);
  });

  it("counts unlabelled tools together rather than repeating the fallback", () => {
    expect(
      summariseSteps([
        { kind: "tool", name: "not_a_real_tool" },
        { kind: "tool", name: "also_not_real" },
      ]),
    ).toBe("2 steps");
  });

  it("still names the tools it knows alongside the count", () => {
    expect(
      summariseSteps([
        { kind: "tool", name: "click" },
        { kind: "tool", name: "not_a_real_tool" },
      ]),
    ).toBe("Clicked once, 1 step");
  });

  it("names a connector call, which is what the report was about", () => {
    expect(
      summariseSteps([
        { kind: "tool", name: "list_available_mcps" },
        { kind: "tool", name: "mcp_call" },
      ]),
    ).toBe("Checked your connectors, Asked to use a connector");
  });
});
