/**
 * v10.1 tool-output token budgets — head+tail disk-truncation envelope.
 */

import { describe, it, expect } from "vitest";
import { maybeTruncateToDisk } from "@/lib/tools/registry";
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

describe("maybeTruncateToDisk (token budget envelope)", () => {
  it("returns small outputs unchanged", async () => {
    const out = await maybeTruncateToDisk("run_command", "short output");
    expect(out.truncated).toBe(false);
    expect(out.value).toBe("short output");
  });

  it("returns mid-size outputs under the token budget unchanged", async () => {
    // ~17k chars but low token density isn't possible with the heuristic —
    // craft ~17k chars that tokenize under 6k tokens (~4 chars/token prose).
    const prose = "the quick brown fox jumps over the lazy dog. ".repeat(380); // ~17.5k chars
    const out = await maybeTruncateToDisk("run_command", prose);
    expect(out.truncated).toBe(false);
  });

  it("spills over-budget outputs to disk with a head+tail preview", async () => {
    const big =
      "START-MARKER\n" +
      "x".repeat(120_000) +
      "\nEND-MARKER exit code 1";
    const out = await maybeTruncateToDisk("run_command", big);
    expect(out.truncated).toBe(true);
    const envelope = out.value as {
      truncated: boolean;
      totalChars: number;
      preview: string;
      diskPath: string;
      message: string;
    };
    expect(envelope.truncated).toBe(true);
    expect(envelope.totalChars).toBe(big.length);
    expect(envelope.preview).toContain("START-MARKER");
    // Tail survives — exit codes / error summaries are visible to the model.
    expect(envelope.preview).toContain("END-MARKER exit code 1");
    expect(envelope.preview).toContain("chars omitted");
    expect(envelope.message).toContain("read_file");
    expect(envelope.diskPath.length).toBeGreaterThan(0);
  });
});
