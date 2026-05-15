import { describe, expect, it } from "vitest";
import { OXC_MAX_BYTES } from "../lib/blueprint/rte/parsers/oxc-extract";
import { parseInWorker } from "../lib/blueprint/rte/parsers/parser-pool";

describe("parser-pool", () => {
  it("skips files over OXC_MAX_BYTES without throwing", async () => {
    const big = "x".repeat(OXC_MAX_BYTES + 1);
    const nodes = await parseInWorker("/tmp/big.ts", big, "big.ts", 0);
    expect(nodes).toEqual([]);
  });

  it("parses a small TS file (sync fallback when worker bundle absent)", async () => {
    const source = "export function hello() { return 1; }\n";
    const nodes = await parseInWorker("/tmp/hello.ts", source, "hello.ts", 0);
    expect(nodes.some((n) => n.type === "function" && n.name === "hello")).toBe(true);
  });
});
