import { describe, expect, it } from "vitest";
import { structureFromSymbols } from "../lib/index/structure-from-symbols";
import type { SymbolRecord } from "../lib/index/symbol-types";

describe("structureFromSymbols", () => {
  it("maps ctags kinds to StructureResult fields", () => {
    const symbols: SymbolRecord[] = [
      { id: "1", name: "handler", kind: "function", path: "src/a.ts", line: 1 },
      { id: "2", name: "User", kind: "class", path: "src/a.ts", line: 10 },
      { id: "3", name: "Config", kind: "interface", path: "src/a.ts", line: 20 },
    ];
    const result = structureFromSymbols(symbols);
    expect(result.functions).toEqual(["handler"]);
    expect(result.classes).toEqual(["User"]);
    expect(result.types).toEqual(["Config"]);
    expect(result.exports).toEqual(expect.arrayContaining(["handler", "User", "Config"]));
  });
});
