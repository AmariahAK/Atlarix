/**
 * Tool-output token budgets — in-band head+tail truncation envelope (v14: no
 * disk spill; over-budget output is truncated in place with a stateless hint).
 */

import { describe, it, expect } from "vitest";
import { maybeTruncateToolOutput } from "@/lib/tools/registry";
import { headTailTruncateToTokens } from "@/lib/truncate";

describe("headTailTruncateToTokens", () => {
  it("passes small content through untouched", () => {
    const { text, omittedChars } = headTailTruncateToTokens("hello world", 100, 50);
    expect(text).toBe("hello world");
    expect(omittedChars).toBe(0);
  });

  it("keeps head + tail with an omitted marker", () => {
    const head = "HEAD-".repeat(2000);
    const middle = "MIDDLE-".repeat(5000);
    const tail = "TAIL-".repeat(2000);
    const { text, omittedChars } = headTailTruncateToTokens(
      head + middle + tail,
      200,
      100,
    );
    expect(omittedChars).toBeGreaterThan(0);
    expect(text.startsWith("HEAD-")).toBe(true);
    expect(text.endsWith("TAIL-")).toBe(true);
    expect(text).toContain("chars omitted");
    expect(text).not.toContain("MIDDLE-".repeat(100));
  });
});

describe("maybeTruncateToolOutput (in-band token budget envelope)", () => {
  it("returns small outputs unchanged", async () => {
    const out = await maybeTruncateToolOutput("run_command", "short output");
    expect(out.truncated).toBe(false);
    expect(out.value).toBe("short output");
  });

  it("returns mid-size outputs under the token budget unchanged", async () => {
    // ~17k chars but low token density isn't possible with the heuristic —
    // craft ~17k chars that tokenize under 6k tokens (~4 chars/token prose).
    const prose = "the quick brown fox jumps over the lazy dog. ".repeat(380); // ~17.5k chars
    const out = await maybeTruncateToolOutput("run_command", prose);
    expect(out.truncated).toBe(false);
  });

  it("truncates over-budget command output in-band (no disk spill)", async () => {
    const big =
      "START-MARKER\n" +
      "x".repeat(120_000) +
      "\nEND-MARKER exit code 1";
    const out = await maybeTruncateToolOutput("run_command", big);
    expect(out.truncated).toBe(true);
    expect(out.totalChars).toBe(big.length);
    // Value is now a plain in-band string — head + tail + stateless notice.
    expect(typeof out.value).toBe("string");
    const value = out.value as string;
    expect(value).toContain("START-MARKER");
    // Tail survives — exit codes / error summaries stay visible to the model.
    expect(value).toContain("END-MARKER exit code 1");
    expect(value).toContain("chars omitted");
    // No fragile temp-file path handed back to the model.
    expect(value).not.toContain("atlarix-tool-outputs");
    expect(value.toLowerCase()).not.toContain("written to");
  });

  it("exempts read_file (it self-paginates via offset/limit)", async () => {
    const big = "L1\n" + "y".repeat(120_000) + "\nLAST";
    const out = await maybeTruncateToolOutput("read_file", big);
    expect(out.truncated).toBe(false);
    expect(out.value).toBe(big);
  });

  it("exempts web_search (its result is N independent pages, not one stream)", async () => {
    const out = await maybeTruncateToolOutput("web_search", {
      text: "x".repeat(120_000),
      sources: [{ title: "t", url: "https://example.com" }],
    });
    expect(out.truncated).toBe(false);
  });
});

/**
 * OBJECT RESULTS ARE TRUNCATED IN THEIR LARGEST STRING FIELD.
 *
 * Truncating `JSON.stringify(result)` was not merely lossy, it was corrupting:
 * the model received invalid JSON, the returned SHAPE changed from object to
 * string, and `wrapUntrustedData`'s closing tag — which lives at the END of the
 * text field, i.e. the MIDDLE of the serialization — was dropped, shipping an
 * unterminated injection-defence envelope on every truncated object result.
 */
describe("maybeTruncateToolOutput — object results", () => {
  const bigText = (marker: string) =>
    `<untrusted-data-abc123>\nSTART ${marker}\n` +
    "content ".repeat(20_000) +
    `\nEND ${marker}\n</untrusted-data-abc123>`;

  it("returns an OBJECT, not a string — the shape is the contract", async () => {
    const out = await maybeTruncateToolOutput("mcp_call", {
      text: bigText("A"),
      sources: [{ title: "t", url: "https://example.com" }],
    });
    expect(out.truncated).toBe(true);
    expect(typeof out.value).toBe("object");
    expect(out.value).not.toBeNull();
  });

  it("leaves sibling fields structurally intact — citations parse them back out", async () => {
    // src/__tests__/citation-sources.test.ts reads `sources` out of the result.
    // Cutting the serialization used to leave that array half-eaten.
    const sources = [
      { title: "one", url: "https://a.example" },
      { title: "two", url: "https://b.example" },
    ];
    const out = await maybeTruncateToolOutput("mcp_call", { text: bigText("B"), sources });
    const v = out.value as { text: string; sources: unknown };
    expect(v.sources).toEqual(sources);
  });

  it("KEEPS the untrusted-data close tag — head+tail of the field keeps its tail", async () => {
    const out = await maybeTruncateToolOutput("mcp_call", { text: bigText("C"), sources: [] });
    const v = out.value as { text: string };
    expect(v.text).toContain("<untrusted-data-abc123>");
    expect(v.text).toContain("</untrusted-data-abc123>");
  });

  it("still produces valid JSON after truncation", async () => {
    const out = await maybeTruncateToolOutput("mcp_call", { text: bigText("D"), sources: [] });
    expect(() => JSON.parse(JSON.stringify(out.value))).not.toThrow();
  });

  it("uses the per-tool hint, not the impossible read_file one", async () => {
    const out = await maybeTruncateToolOutput("mcp_call", { text: bigText("E"), sources: [] });
    const v = out.value as { text: string };
    expect(v.text).toContain("call the same MCP tool with narrower arguments");
    expect(v.text).not.toContain("call read_file again");
  });

  it("string results are unchanged in behaviour", async () => {
    const out = await maybeTruncateToolOutput("run_command", "z".repeat(120_000));
    expect(out.truncated).toBe(true);
    expect(typeof out.value).toBe("string");
  });
});
