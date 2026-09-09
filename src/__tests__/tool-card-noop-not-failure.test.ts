/**
 * `success: false` is not always a failure — and a generic fallback string is
 * the worst possible way to say so.
 *
 * OBSERVED 2026-09-02, in the packaged app. Two rows, both green ✓ in the
 * header, both with a red **"Tool failed"** body, and both the system working
 * exactly right. The payloads are the real ones, read back out of
 * `session_messages`:
 *
 *   compress_context → {"success":false,"status":"noop","reason":…,"summary":
 *     "Already compact: history is 7474 tokens (~39% of the 19200-token usable
 *     budget) — nothing worth compacting. No action needed."}
 *
 *   the loop guard → {"success":false,"loop_guidance":"You have made this exact
 *     read_url call 3 times in a row with identical input… This call was NOT
 *     executed. Do not repeat it."}
 *
 * Each had written a better explanation than the UI could invent, in a field the
 * UI did not read (`error` and `message` were the only two it looked at). So the
 * card asserted something untrue AND discarded the truth sitting next to it.
 *
 * The header was wrong in the other direction at the same time: the label map
 * says "Context compacted" for `compress_context`, which is the one thing that
 * had not happened.
 */

import { describe, expect, it } from "vitest";
import { buildToolExpandView } from "@/lib/chat/tool-expand-view";
import { noopSummary } from "@/lib/chat/stream-tool-display";

const NOOP_RESULT = JSON.stringify({
  success: false,
  reason: "Nearing 60% context; prior turns contain long browser page dumps.",
  tokensBefore: 7474,
  tokensAfter: 7474,
  tokensFreed: 0,
  strategy: "none",
  summary:
    "Already compact: history is 7474 tokens (~39% of the 19200-token usable budget) — nothing worth compacting. No action needed.",
  status: "noop",
  summaryPersisted: false,
});

const LOOP_RESULT = JSON.stringify({
  success: false,
  loop_guidance:
    "You have made this exact read_url call 3 times in a row with identical input, and the result will not change. This call was NOT executed. Do not repeat it. Change your approach — gather different information or try a different tool.",
});

describe("a no-op is not a failure", () => {
  it("shows the compactor's own explanation, and NOT in red", () => {
    const view = buildToolExpandView(
      "compress_context",
      {},
      NOOP_RESULT,
      "done",
    );
    expect(view?.kind).toBe("text");
    const v = view as { body?: string; isError?: boolean };
    expect(v.body).toContain("Already compact");
    expect(v.body).toContain("nothing worth compacting");
    expect(v.body).not.toBe("Tool failed");
    // The green ✓ was right; the red body was the lie.
    expect(v.isError).toBeFalsy();
  });

  it("shows the loop guard's guidance, and NOT in red", () => {
    const view = buildToolExpandView(
      "read_url",
      { url: "https://x" },
      LOOP_RESULT,
      "done",
    );
    const v = view as { body?: string; isError?: boolean };
    expect(v.body).toContain("3 times in a row");
    expect(v.body).toContain("NOT executed");
    expect(v.isError).toBeFalsy();
  });

  it("the header says what happened, not what didn't", () => {
    // "Context compacted" for a call that compacted nothing. The replacement is
    // the wording the compaction BANNER has used since v14.8.11, so the two
    // surfaces cannot drift.
    expect(noopSummary("compress_context", NOOP_RESULT)).toBe(
      "Context already compact",
    );
  });

  it("leaves a real compaction alone", () => {
    const applied = JSON.stringify({
      success: true,
      status: "completed",
      tokensBefore: 120000,
      tokensAfter: 40000,
    });
    expect(noopSummary("compress_context", applied)).toBeNull();
  });

  it("does not guess at no-op for other tools", () => {
    // `status: "noop"` is a contract only compress_context declares. Inferring
    // "did anything happen" from any other result is how you get a confidently
    // wrong label.
    expect(noopSummary("read_url", NOOP_RESULT)).toBeNull();
    expect(noopSummary("compress_context", "not json")).toBeNull();
    expect(noopSummary("compress_context", undefined)).toBeNull();
  });
});

describe("a real failure is still a real failure", () => {
  it("shows the error, in red", () => {
    const view = buildToolExpandView(
      "read_url",
      { url: "https://x" },
      JSON.stringify({ success: false, error: "Failed to read URL: HTTP 404" }),
      "done",
    );
    const v = view as { body?: string; isError?: boolean };
    expect(v.body).toBe("Failed to read URL: HTTP 404");
    expect(v.isError).toBe(true);
  });

  it("prefers a specific field over the generic fallback", () => {
    // The chain now walks error → message → loop_guidance → summary → reason →
    // detail → note. A tool that explains itself in ANY of them gets to.
    for (const field of ["message", "detail", "note", "reason"] as const) {
      const view = buildToolExpandView(
        "some_tool",
        {},
        JSON.stringify({ success: false, [field]: `explained via ${field}` }),
        "done",
      );
      expect((view as { body?: string }).body, field).toBe(
        `explained via ${field}`,
      );
    }
  });

  it("falls back to 'Tool failed' ONLY when nothing explains it", () => {
    const view = buildToolExpandView(
      "some_tool",
      {},
      JSON.stringify({ success: false }),
      "done",
    );
    const v = view as { body?: string; isError?: boolean };
    expect(v.body).toBe("Tool failed");
    expect(v.isError).toBe(true);
  });
});

/**
 * The NATIVE tool-calling path wraps the same payload differently.
 *
 * `ToolRegistry.execute`'s failure branch fills in `error: "TOOL_ERROR"` and
 * `message: "Tool returned an error"` when the tool supplied neither. Those are
 * sentinels for the model, and the first version of this fix surfaced
 * "TOOL_ERROR" to the user as though it were a real error code — which is worse
 * than "Tool failed", because it looks like something you could look up.
 */
describe("the native envelope's sentinels", () => {
  const nativeNoop = JSON.stringify({
    success: false,
    tool: "compress_context",
    error: "TOOL_ERROR",
    message: "Tool returned an error",
    partial: null,
    reason: "Nearing 60% context.",
    summary:
      "Already compact: history is 7474 tokens — nothing worth compacting.",
    status: "noop",
  });

  it("skips the sentinels and reaches the tool's own words", () => {
    const view = buildToolExpandView(
      "compress_context",
      {},
      nativeNoop,
      "done",
    );
    const v = view as { body?: string; isError?: boolean };
    expect(v.body).toContain("Already compact");
    expect(v.body).not.toContain("TOOL_ERROR");
    expect(v.isError).toBeFalsy();
  });

  it("still shows a sentinel when it is genuinely all there is", () => {
    // Skipping them entirely would leave an empty card, which is a different
    // kind of unhelpful. They are remembered as a last resort, not discarded.
    const view = buildToolExpandView(
      "some_tool",
      {},
      JSON.stringify({
        success: false,
        error: "TOOL_ERROR",
        message: "Tool returned an error",
      }),
      "done",
    );
    const v = view as { body?: string; isError?: boolean };
    expect(v.body).toBe("TOOL_ERROR");
    expect(v.isError).toBe(true);
  });
});
