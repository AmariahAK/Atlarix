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
});
