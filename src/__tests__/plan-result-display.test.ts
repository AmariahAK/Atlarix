import { describe, expect, it } from "vitest";
import { buildToolExpandView } from "@/lib/chat/tool-expand-view";
import { formatToolResultPreview } from "@/lib/chat/stream-tool-display";
import {
  stripMultilineToolJsonEnvelopes,
  isToolResultEnvelopeObject,
} from "@/lib/chat/answer-display";

/**
 * Plan-tool results must never reach the user as raw JSON.
 *
 * Observed bug: creating or updating a plan rendered a mid-JSON fragment in the
 * visible reply —
 *   `Fix: max(max_over_time) hangs (Issue #23474)\n","progress":"0/5 steps don`
 *
 * Cause was NOT the tool card (which renders `message`, or "Done"). It was the
 * assistant-text stripper, at two points:
 *
 *  1. `isToolResultEnvelopeObject` (answer-display.ts) only recognises a result
 *     when `success` is joined by one of result/error/message/cost. `update_step`
 *     and `set_status` carried none, so an echoed copy was left intact as prose.
 *  2. A TRUNCATED echo failed `findJsonObjectEnd`, and the stripper emitted the
 *     whole remainder verbatim — the reported fragment.
 *
 * Both are guarded here. Shapes mirror the return statements in
 * `src/lib/tools/plan.ts`; the end-to-end path is covered by
 * tests/agent-evals/plan-update-step.eval.test.ts.
 */

const PLAN_CONTENT = `# Fix: max(max_over_time) hangs (Issue #23474)

1. [x] **Fix the condition in \`pkg/logql/evaluator.go:337\`**
2. [ ] **Add test coverage**
3. [ ] **Run existing tests**
4. [ ] **Run linter**
5. [ ] **Verify the query from the issue**
`;

const PLAN_ID = "11111111-2222-3333-4444-555555555555";
const MARKER = `<!-- atlarix-plan-artifact:${PLAN_ID} -->`;

const RESULTS = {
  write: {
    success: true,
    planId: PLAN_ID,
    planStatus: "plan",
    contentPreview: PLAN_CONTENT.slice(0, 400),
    marker: MARKER,
    progress: "1/5 steps done",
    message: "Plan updated.",
  },
  update_step: {
    success: true,
    planId: PLAN_ID,
    step: { index: 1, text: "Fix the condition", state: "done" },
    progress: "1/5 steps done",
    message: "Step 1 → done (1/5 steps done).",
  },
  set_status: {
    success: true,
    planId: PLAN_ID,
    planStatus: "building",
    marker: MARKER,
    message: 'Plan status set to "building".',
  },
} as const;

describe("plan results are recognisable tool envelopes", () => {
  for (const [op, result] of Object.entries(RESULTS)) {
    it(`${op} carries a field that makes it strippable`, () => {
      expect(isToolResultEnvelopeObject(result as never)).toBe(true);
    });
  }
});

describe("plan tool cards say something useful", () => {
  it("write renders status, progress and the checklist", () => {
    const view = buildToolExpandView(
      "plan",
      {},
      JSON.stringify(RESULTS.write),
      "done",
    );
    expect(view.kind).toBe("text");
    const body = (view as { body: string }).body;
    expect(body).toContain("Plan updated.");
    expect(body).toContain("plan");
    expect(body).toContain("1/5 steps done");
    // Checklist state comes through with ASCII markers.
    expect(body).toContain("[x] **Fix the condition");
    expect(body).toContain("[ ] **Add test coverage");
    // This fixture's five steps fit inside the 400-char preview, so nothing was cut.
    expect(body).not.toMatch(/… \d+ more/);
  });

  it("says how many steps were cut when contentPreview truncates the checklist", () => {
    // contentPreview is capped at 400 chars upstream (plan.ts), so a long plan's
    // checklist arrives partial. The card must not imply the plan is shorter.
    const long = `# Big plan\n\n${Array.from(
      { length: 12 },
      (_, i) =>
        `${i + 1}. [ ] **Step ${i + 1} with a deliberately long description to eat characters**`,
    ).join("\n")}\n`;
    const raw = JSON.stringify({
      ...RESULTS.write,
      contentPreview: long.slice(0, 400),
      progress: "0/12 steps done",
    });
    const body = (
      buildToolExpandView("plan", {}, raw, "done") as { body: string }
    ).body;
    expect(body).toContain("0/12 steps done");
    expect(body).toMatch(/… \d+ more/);
  });

  for (const op of ["update_step", "set_status"] as const) {
    it(`${op} renders its message rather than a bare "Done"`, () => {
      const raw = JSON.stringify(RESULTS[op]);
      const body = (
        buildToolExpandView("plan", {}, raw, "done") as { body: string }
      ).body;
      expect(body).toContain(RESULTS[op].message);
      expect(formatToolResultPreview("plan", raw, "done")).toBe(
        RESULTS[op].message,
      );
    });
  }
});

describe("an echoed plan result never renders as JSON", () => {
  for (const [op, result] of Object.entries(RESULTS)) {
    it(`strips a complete echoed ${op} result`, () => {
      const out = stripMultilineToolJsonEnvelopes(
        `Plan updated\n\n${JSON.stringify(result)}\n\nNow starting step 2.`,
      );
      expect(out).not.toContain('"success"');
      expect(out).not.toContain('"progress"');
      expect(out).not.toContain(PLAN_ID);
      expect(out).toContain("Plan updated");
      expect(out).toContain("Now starting step 2.");
    });
  }

  it("drops a TRUNCATED echo instead of leaking a mid-JSON fragment", () => {
    // The reported symptom: the echo is cut mid-value, so findJsonObjectEnd
    // returns null and the remainder used to be emitted verbatim.
    const truncated = `Plan updated\n\n${JSON.stringify(RESULTS.write).slice(0, 220)}`;
    const out = stripMultilineToolJsonEnvelopes(truncated);
    expect(out).not.toContain('"progress"');
    expect(out).not.toContain("contentPreview");
    expect(out).not.toContain("Issue #23474");
    expect(out.trim()).toBe("Plan updated");
  });
});

describe("the display fallback rejects JSON fragments, not just whole objects", () => {
  // A tool with no dedicated branch falls through to the generic tail. The old
  // guard tested only `startsWith("{")`, so a mid-object fragment sailed through
  // and capPreview cut it at 300 chars mid-token — the failure documented at
  // tool-expand-view.ts:44-51. Any tool can hit this, so guard the class.
  const fragment =
    'Fix: max(max_over_time) hangs (Issue #23474)\\n","progress":"0/5 steps done","message":"Plan created."}';

  it("does not render a mid-object fragment as a preview", () => {
    const raw = JSON.stringify({ success: true, output: fragment });
    expect(formatToolResultPreview("some_unbranched_tool", raw, "done")).toBe(
      "Done",
    );
  });

  it("does not render a mid-object fragment in the expand view", () => {
    const raw = JSON.stringify({ success: true, output: fragment });
    const view = buildToolExpandView("some_unbranched_tool", {}, raw, "done");
    expect(JSON.stringify(view)).not.toContain('"progress"');
  });

  it("still renders an ordinary sentence containing a colon", () => {
    const raw = JSON.stringify({
      success: true,
      message: "Done: 3 files updated.",
    });
    expect(formatToolResultPreview("some_unbranched_tool", raw, "done")).toBe(
      "Done: 3 files updated.",
    );
  });
});

describe("prose containing braces is left alone", () => {
  it("keeps an ordinary object literal the model is discussing", () => {
    const prose = "Pass {timeout: 5000} to the helper and it retries.";
    expect(stripMultilineToolJsonEnvelopes(prose)).toBe(prose);
  });

  it("keeps an unterminated brace in prose", () => {
    const prose = "The config starts with { and continues on the next line.";
    expect(stripMultilineToolJsonEnvelopes(prose)).toBe(prose);
  });

  it("keeps a JSON object that is not a tool result", () => {
    const prose =
      'The response was {"name":"atlarix","version":"14.21.0"} exactly.';
    expect(stripMultilineToolJsonEnvelopes(prose)).toContain('"name"');
  });
});
