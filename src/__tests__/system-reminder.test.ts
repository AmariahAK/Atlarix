import { describe, expect, it } from "vitest";
import { systemReminder } from "@/lib/streaming/system-reminder";

/**
 * v14.8.8 — out-of-band harness message framing.
 */
describe("systemReminder", () => {
  it("wraps content in a <system-reminder> tag", () => {
    const out = systemReminder("do the thing");
    expect(out).toBe("<system-reminder>\ndo the thing\n</system-reminder>");
  });

  it("is idempotent — does not double-wrap already-wrapped content", () => {
    const once = systemReminder("x");
    expect(systemReminder(once)).toBe(once);
  });

  it("leaves empty/whitespace content unchanged (nothing to frame)", () => {
    expect(systemReminder("")).toBe("");
    expect(systemReminder("   ")).toBe("   ");
  });

  it("preserves the inner content verbatim (e.g. tool-result markers)", () => {
    const body = "Here are the results of the tools you called:\n<tool_result>ok</tool_result>";
    expect(systemReminder(body)).toContain(body);
  });
});
