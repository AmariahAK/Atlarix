import { describe, expect, it } from "vitest";
import { parsePlanChecklist, setStepStateInPlanMarkdown } from "@/lib/tasks/plan-checklist";

describe("a plan step that wraps onto indented lines (QA P1)", () => {
  const plan = [
    "## Steps",
    "1. [x] Implement `toggle(id)`: flip done in place, return the",
    "   updated `Todo`, `undefined` when absent.",
    "   - keeps ids stable",
    "2. [ ] Add tests (toggle on, toggle",
    "   off, remove).",
    "",
    "Notes after.",
  ].join("\n");

  it("is one step with its whole text; sub-bullets stay out", () => {
    const steps = parsePlanChecklist(plan);
    expect(steps.map((s) => s.text)).toEqual([
      "Implement `toggle(id)`: flip done in place, return the updated `Todo`, `undefined` when absent.",
      "Add tests (toggle on, toggle off, remove).",
    ]);
    expect(steps.map((s) => s.line)).toEqual([1, 4]);
  });

  it("is still found by the first line's words when marked", () => {
    const r = setStepStateInPlanMarkdown(plan, { stepText: "Add tests (toggle on, toggle" }, "done");
    expect(r.changed).toBe(true);
    expect(r.content.split("\n")[4]).toBe("2. [x] Add tests (toggle on, toggle");
  });
});

describe("plainStepText (QA A2/C2)", () => {
  it("drops the model's own number, checkbox and markdown marks", async () => {
    const { plainStepText } = await import("@/lib/tasks/plan-checklist");
    expect(plainStepText("1. Add `toggle(id)` to `src/todo.ts`")).toBe("Add toggle(id) to src/todo.ts");
    expect(plainStepText("**3. Verify**")).toBe("Verify");
    expect(plainStepText("2) [x] **Run** the tests")).toBe("Run the tests");
  });
});
