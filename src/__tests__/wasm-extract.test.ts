import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractWithWasm, mergeWasmWithRegex } from "../lib/blueprint/rte/parsers/wasm-extract";
import type { BlueprintNode } from "../lib/blueprint/rte/parsers/types";

const FIXTURES = path.join(__dirname, "fixtures", "wasm");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf-8");
}

describe("wasm-extract", () => {
  it("parses Python class and function", async () => {
    const source = readFixture("fixture.py");
    const nodes = await extractWithWasm(source, "python", "fixture.py", 0);
    expect(nodes.some((n) => n.type === "class" && n.name === "UserService")).toBe(true);
    expect(nodes.some((n) => n.type === "function" && n.name === "list_items")).toBe(true);
  });

  it("parses Go struct and method", async () => {
    const source = readFixture("fixture.go");
    const nodes = await extractWithWasm(source, "go", "fixture.go", 0);
    expect(nodes.some((n) => n.type === "class" && n.name === "Server")).toBe(true);
    expect(nodes.some((n) => n.type === "function" && n.name === "Listen")).toBe(true);
  });

  it("parses Rust struct and function", async () => {
    const source = readFixture("fixture.rs");
    const nodes = await extractWithWasm(source, "rust", "fixture.rs", 0);
    expect(nodes.some((n) => n.type === "class" && n.name === "Config")).toBe(true);
    expect(nodes.some((n) => n.type === "function" && n.name === "run")).toBe(true);
  });

  it("returns empty array for malformed source", async () => {
    const nodes = await extractWithWasm("def ((( broken", "python", "bad.py", 0);
    expect(nodes).toEqual([]);
  });

  it("wasm wins function over regex at same key", () => {
    const rel = "src/handler.py";
    const wasm: BlueprintNode[] = [
      { id: "w1", type: "function", name: "handler", file: rel, line: 10 },
    ];
    const regex: BlueprintNode[] = [
      { id: "r1", type: "function", name: "handler", file: rel, line: 99 },
    ];
    const merged = mergeWasmWithRegex(wasm, regex);
    expect(merged.filter((n) => n.type === "function")).toHaveLength(1);
    expect(merged.find((n) => n.type === "function")!.line).toBe(10);
  });
});
