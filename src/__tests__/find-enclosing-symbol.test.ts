import { describe, expect, it } from "vitest";
import { findEnclosingSymbol } from "@/lib/index/ctags-index";
import type { SymbolIndexCache, SymbolRecord } from "@/lib/index/symbol-types";

function cacheOf(symbols: Partial<SymbolRecord>[]): SymbolIndexCache {
  return {
    manifest: {
      projectPath: "/ws",
      timestamp: 0,
      fileCount: 1,
      symbolCount: symbols.length,
      engine: "ctags",
    },
    symbols: symbols.map((s, i) => ({
      id: String(i),
      name: s.name ?? `sym${i}`,
      kind: s.kind ?? "function",
      path: s.path ?? "a.ts",
      line: s.line ?? 1,
      endLine: s.endLine,
      scope: s.scope,
      signature: s.signature,
    })),
  };
}

describe("findEnclosingSymbol", () => {
  it("returns the symbol whose [line, endLine] range contains the match", () => {
    const cache = cacheOf([{ name: "create", line: 10, endLine: 50 }]);
    expect(findEnclosingSymbol(cache, "a.ts", 30)?.name).toBe("create");
  });

  it("prefers the innermost (deepest) enclosing symbol", () => {
    const cache = cacheOf([
      { name: "UserView", kind: "class", line: 1, endLine: 100 },
      { name: "create", scope: "UserView", line: 20, endLine: 40 },
    ]);
    expect(findEnclosingSymbol(cache, "a.ts", 25)?.name).toBe("create");
    // Outside the method but inside the class → the class.
    expect(findEnclosingSymbol(cache, "a.ts", 80)?.name).toBe("UserView");
  });

  it("falls back to the nearest preceding definition when endLine is absent", () => {
    const cache = cacheOf([
      { name: "first", line: 5 },
      { name: "second", line: 60 },
    ]);
    expect(findEnclosingSymbol(cache, "a.ts", 40)?.name).toBe("first");
    expect(findEnclosingSymbol(cache, "a.ts", 70)?.name).toBe("second");
  });

  it("returns null for a file with no symbols or a match above all of them", () => {
    expect(findEnclosingSymbol(cacheOf([]), "a.ts", 10)).toBeNull();
    const cache = cacheOf([{ name: "later", line: 50 }]);
    expect(findEnclosingSymbol(cache, "a.ts", 10)).toBeNull();
  });

  it("scopes to the requested file only", () => {
    const cache = cacheOf([
      { name: "inA", path: "a.ts", line: 1, endLine: 100 },
      { name: "inB", path: "b.ts", line: 1, endLine: 100 },
    ]);
    expect(findEnclosingSymbol(cache, "b.ts", 50)?.name).toBe("inB");
  });
});
