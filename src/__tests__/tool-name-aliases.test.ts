/**
 * Renaming a tool breaks two things silently unless the old name still resolves:
 * persisted sessions whose history contains it, and any model that learned it.
 *
 * `preview_test` → `browser_test` (v14.23.0) is the first such rename, so this also
 * pins the alias CONTRACT: a retired name resolves, and is advertised nowhere.
 *
 * v14.41.0 added FIVE more at once (browser 6→2) and, in doing so, found that this
 * file had been pinning half a contract. Every assertion here was about
 * `ToolRegistry.get` / `resolveName` — the alias MAP — and passed, while neither
 * dispatch path honoured it: both look a tool up in the resolved ToolSet, which
 * advertises canonical names only, so a call by a retired name died as
 * "Unknown tool" before the map was ever consulted. The map was decoration.
 *
 * So the contract has three parts, and only the first two are testable here:
 *   1. a retired name RESOLVES to its current tool;
 *   2. it is advertised NOWHERE — not in `getAll()`, not in any description;
 *   3. a DISPATCHED call by that name runs, and the permission gate sees both
 *      names. That is behaviour, not a lookup, and it is pinned in
 *      `tests/agent-evals/permission-ruleset.eval.test.ts` through the real
 *      funnel. Do not "cover" it with another registry assertion.
 */

import { describe, expect, it } from "vitest";
import "../lib/tools";
import { ToolRegistry } from "../lib/tools/registry";
import {
  getToolActivityLabel,
  getToolDoneLabel,
} from "../lib/tool-activity-labels";

describe("tool name aliases", () => {
  it("browser_test is registered under its current name", () => {
    expect(ToolRegistry.get("browser_test")?.name).toBe("browser_test");
  });

  it("the retired preview_test name still resolves to it", () => {
    // A persisted session or a model that learned the old name must keep working.
    expect(ToolRegistry.get("preview_test")?.name).toBe("browser_test");
    expect(ToolRegistry.resolveName("preview_test")).toBe("browser_test");
  });

  it("resolveName is identity for a name that is not an alias", () => {
    expect(ToolRegistry.resolveName("browser_test")).toBe("browser_test");
    expect(ToolRegistry.resolveName("grep")).toBe("grep");
  });

  it("an unknown name resolves to nothing", () => {
    expect(ToolRegistry.get("no_such_tool")).toBeUndefined();
  });

  /**
   * The reason aliases live in their own map. If they shared `tools`, every toolset,
   * the golden-toolset eval and the registry audit would see the tool twice.
   */
  it("aliases are never advertised — getAll() lists each tool exactly once", () => {
    const names = ToolRegistry.getAll().map((t) => t.name);
    expect(names).toContain("browser_test");
    expect(names).not.toContain("preview_test");
    expect(names.filter((n) => n === "browser_test")).toHaveLength(1);
    // No duplicates anywhere in the registry.
    expect(new Set(names).size).toBe(names.length);
  });

  it("no registered tool description mentions the retired name", () => {
    // Prompt budget must not be spent telling the model about a name it shouldn't use.
    const leaking = ToolRegistry.getAll().filter((t) =>
      t.description.includes("preview_test"),
    );
    expect(leaking.map((t) => t.name)).toEqual([]);
  });

  it("the renamed tool has real activity labels, not the conjugation fallback", () => {
    // A tool with no LABELS entry falls back to a template whose first /ing\b/ sits
    // inside "Runn·ing", which produced "Runned <tool>".
    expect(getToolActivityLabel("browser_test")).toBe("Testing the app…");
    expect(getToolDoneLabel("browser_test")).toBe("Tested the app");
    expect(getToolDoneLabel("browser_test")).not.toMatch(/Runned/);
  });
});

/**
 * v14.41.0: browser 6→2. Five names retired in one change, which is where a
 * hand-maintained alias list goes wrong — one typo and that name resolves to
 * nothing, silently, since a missing alias looks exactly like a name that was
 * never retired. (This is not hypothetical: a bulk find-and-replace over this
 * file's own source turned `"browser_batch"` into a sentence fragment, and only
 * an assertion on the exact list caught it.)
 */
describe("browser 6→2 aliases", () => {
  const RETIRED = [
    "browser_navigate",
    "browser_interact",
    "browser_tabs",
    "browser_find",
    "browser_batch",
  ] as const;

  it("all five retired names resolve to `browser`", () => {
    for (const name of RETIRED) {
      expect(ToolRegistry.get(name)?.name, `${name} must resolve`).toBe(
        "browser",
      );
      expect(ToolRegistry.resolveName(name)).toBe("browser");
    }
  });

  it("the alias list is EXACTLY those five — no typos, no strays", () => {
    // Asserting on the set, not on "each one I remembered to check": a mangled
    // entry resolves to nothing and reads identically to a name never retired.
    const aliases = [...(ToolRegistry.get("browser")?.aliases ?? [])].sort();
    expect(aliases).toEqual([...RETIRED].sort());
  });

  it("browser_inspect is NOT an alias — it survived as its own tool", () => {
    // The split is read vs act. Folding inspect in would have diluted the sole
    // NEVER_TRIM description, whose wording steers away from an observed bug.
    expect(ToolRegistry.get("browser_inspect")?.name).toBe("browser_inspect");
    expect(ToolRegistry.resolveName("browser_inspect")).toBe("browser_inspect");
  });

  it("none of the five is advertised, and none appears in any description", () => {
    const names = ToolRegistry.getAll().map((t) => t.name);
    for (const retired of RETIRED) {
      expect(names, `${retired} must not be advertised`).not.toContain(retired);
    }
    // Prompt budget must not be spent naming a call the model cannot make. The
    // model-facing strings say `browser({action:"navigate"})`, not the old name.
    const leaking = ToolRegistry.getAll().filter((t) =>
      RETIRED.some((r) => t.description.includes(r)),
    );
    expect(leaking.map((t) => t.name)).toEqual([]);
  });

  it("all five still label historical activity rows correctly", () => {
    // A reloaded session's stored rows carry the OLD name. Dropping their label
    // entries would have regressed every one of them to "Runned browser_tabs".
    expect(getToolDoneLabel("browser_navigate")).toBe("Opened page");
    expect(getToolDoneLabel("browser_interact")).toBe("Acted on page");
    for (const name of RETIRED) {
      expect(getToolDoneLabel(name), `${name} label`).not.toMatch(/Runned/);
      expect(getToolActivityLabel(name), `${name} running label`).not.toMatch(
        /Runned/,
      );
    }
  });

  it("an alias carries the NAME and no action, so the tool must not guess one", () => {
    // `browser_navigate` resolves to `browser`, but nothing fills in
    // action:"navigate" — the args are whatever the old tool took. The handler's
    // default branch therefore has to name the correct call rather than pick an
    // action, because guessing would run the wrong one on a real page.
    const desc = String(ToolRegistry.get("browser")!.description);
    expect(desc).toContain('action:"navigate"');
    // And the `action` enum is the full set the six tools used to cover.
    const params = ToolRegistry.get("browser")!.parameters as {
      properties?: { action?: { enum?: string[] } };
    };
    expect(params.properties?.action?.enum).toEqual([
      "navigate",
      "find",
      "click",
      "fill",
      "key",
      "hover",
      "scroll",
      "tabs",
      "batch",
    ]);
  });
});
