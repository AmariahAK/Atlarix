/**
 * Renaming a tool breaks two things silently unless the old name still resolves:
 * persisted sessions whose history contains it, and any model that learned it.
 *
 * `preview_test` → `browser_test` (v14.23.0) is the first such rename, so this also
 * pins the alias CONTRACT: a retired name resolves, and is advertised nowhere.
 */

import { describe, expect, it } from "vitest";
import "../lib/tools";
import { ToolRegistry } from "../lib/tools/registry";
import { getToolActivityLabel, getToolDoneLabel } from "../lib/tool-activity-labels";

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
