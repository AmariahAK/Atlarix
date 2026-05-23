import { describe, expect, it } from "vitest";
import { parseCtagsJsonOutput, ctagsKindToNodeType } from "../lib/index/ctags-parse";

describe("ctags-parse", () => {
  it("parses newline-delimited JSON symbols", () => {
    const root = "/tmp/project";
    const stdout = [
      JSON.stringify({
        name: "handleLogin",
        path: "/tmp/project/src/auth.ts",
        line: 42,
        kind: "function",
        signature: "(email: string)",
      }),
      JSON.stringify({
        name: "AuthService",
        path: "/tmp/project/src/auth.ts",
        line: 10,
        kind: "class",
      }),
    ].join("\n");

    const symbols = parseCtagsJsonOutput(stdout, root);
    expect(symbols).toHaveLength(2);
    expect(symbols[0].name).toBe("handleLogin");
    expect(symbols[0].path).toBe("src/auth.ts");
    expect(symbols[0].line).toBe(42);
    expect(symbols[0].signature).toBe("(email: string)");
  });

  it("dedupes identical symbols", () => {
    const root = "/tmp/p";
    const line = JSON.stringify({
      name: "foo",
      path: "/tmp/p/a.ts",
      line: 1,
      kind: "f",
    });
    const symbols = parseCtagsJsonOutput(`${line}\n${line}`, root);
    expect(symbols).toHaveLength(1);
  });

  it("maps ctags kinds to blueprint node types", () => {
    expect(ctagsKindToNodeType("f")).toBe("function");
    expect(ctagsKindToNodeType("class")).toBe("class");
    expect(ctagsKindToNodeType("interface")).toBe("feature");
  });
});
