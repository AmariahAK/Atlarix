import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  extractNodesFromOxcSync,
  mergeBlueprintNodes,
  nodeMergeKey,
  type MergeKind,
} from "../lib/blueprint/rte/parsers/oxc-extract";
import type { BlueprintNode } from "../lib/blueprint/rte/parsers/types";

const FIXTURES = path.join(__dirname, "fixtures", "oxc");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf-8");
}

describe("oxc-extract", () => {
  it("parses fixture.ts with class, function, and export", () => {
    const content = readFixture("fixture.ts");
    const nodes = extractNodesFromOxcSync(content, path.join(FIXTURES, "fixture.ts"), "fixture.ts", 0);
    expect(nodes).not.toBeNull();
    expect(nodes!.some((n) => n.type === "class" && n.name === "Repo")).toBe(true);
    expect(nodes!.some((n) => n.type === "function" && n.name === "createRepo")).toBe(true);
  });

  it("parses fixture.tsx with component export", () => {
    const content = readFixture("fixture.tsx");
    const nodes = extractNodesFromOxcSync(content, path.join(FIXTURES, "fixture.tsx"), "fixture.tsx", 0);
    expect(nodes).not.toBeNull();
    expect(nodes!.some((n) => n.type === "function" && n.name === "App")).toBe(true);
  });

  it("parses fixture.js CJS export", () => {
    const content = readFixture("fixture.js");
    const nodes = extractNodesFromOxcSync(content, path.join(FIXTURES, "fixture.js"), "fixture.js", 0);
    expect(nodes).not.toBeNull();
    expect(nodes!.some((n) => n.type === "function")).toBe(true);
  });

  it("parses fixture.jsx class component", () => {
    const content = readFixture("fixture.jsx");
    const nodes = extractNodesFromOxcSync(content, path.join(FIXTURES, "fixture.jsx"), "fixture.jsx", 0);
    expect(nodes).not.toBeNull();
    expect(nodes!.some((n) => n.type === "class" && n.name === "Legacy")).toBe(true);
  });

  it("returns null for malformed.ts (regex fallback path)", () => {
    const content = readFixture("fixture.malformed.txt");
    const nodes = extractNodesFromOxcSync(
      content,
      path.join(FIXTURES, "fixture.malformed.ts"),
      "fixture.malformed.ts",
      0,
    );
    expect(nodes).toBeNull();
  });
});

describe("mergeBlueprintNodes", () => {
  const rel = "src/routes.ts";

  function node(
    type: BlueprintNode["type"],
    name: string,
    line: number,
    extra?: Partial<BlueprintNode>,
  ): BlueprintNode {
    return {
      id: `${type}-${name}-${line}`,
      type,
      name,
      file: rel,
      line,
      ...extra,
    };
  }

  it("oxc wins function over regex at same key", () => {
    const oxc = [node("function", "handler", 10)];
    const regex = [node("function", "handler", 99)];
    const merged = mergeBlueprintNodes(oxc, regex);
    expect(merged.filter((n) => n.type === "function")).toHaveLength(1);
    expect(merged.find((n) => n.type === "function")!.line).toBe(10);
  });

  it("keeps regex route nodes", () => {
    const regex = [node("api", "GET /api", 5, { method: "GET", path: "/api" })];
    const merged = mergeBlueprintNodes([], regex);
    expect(merged.some((n) => n.type === "api")).toBe(true);
  });

  it("keeps both when route line differs by >5 from oxc function", () => {
    const oxc = [node("function", "handler", 10)];
    const regex = [node("api", "GET /x", 50, { method: "GET", path: "/x" })];
    const merged = mergeBlueprintNodes(oxc, regex);
    expect(merged).toHaveLength(2);
  });

  it("merge keys are stable", () => {
    const key = nodeMergeKey(rel, "function" as MergeKind, "foo");
    expect(key).toBe("src/routes.ts:function:foo");
  });
});
