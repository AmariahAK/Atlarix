import { describe, expect, it } from "vitest";
import { shouldUseTextToolFallback } from "@/lib/stream/text-tool-fallback";
import { getToolDoneLabel } from "@/lib/tool-activity-labels";

describe("shouldUseTextToolFallback", () => {
  it("skips text XML fallback for native FC providers", () => {
    expect(shouldUseTextToolFallback("compass")).toBe(false);
    expect(shouldUseTextToolFallback("openrouter")).toBe(false);
  });

  it("allows fallback for unknown providers", () => {
    expect(shouldUseTextToolFallback("custom-provider")).toBe(true);
  });
});

describe("getToolDoneLabel", () => {
  it("does not produce Runned unknown for missing tool names", () => {
    expect(getToolDoneLabel("unknown")).toBe("Completed tool");
    expect(getToolDoneLabel("")).toBe("Done");
  });
});
