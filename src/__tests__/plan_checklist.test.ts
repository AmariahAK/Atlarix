/**
 * v10: live plan step progress — checklist parsing + checkbox rewriting.
 */
import { describe, it, expect } from "vitest";
import {
  parsePlanChecklist,
  setStepStateInPlanMarkdown,
  markAllChecklistStepsDone,
} from "@/lib/tasks/plan-checklist";

const PLAN = `# Add auth

**Status:** In progress

1. [ ] Create login form
2. [~] Wire Supabase client
3. [x] Add env vars
4. [!] Configure OAuth redirect
5. Write tests
`;

describe("parsePlanChecklist", () => {
  it("parses numbered checkbox steps with states", () => {
    const steps = parsePlanChecklist(PLAN);
    expect(steps).toHaveLength(5);
    expect(steps[0]).toMatchObject({ index: 1, text: "Create login form", state: "todo" });
    expect(steps[1]).toMatchObject({ index: 2, state: "in_progress" });
    expect(steps[2]).toMatchObject({ index: 3, state: "done" });
    expect(steps[3]).toMatchObject({ index: 4, state: "blocked" });
    expect(steps[4]).toMatchObject({ index: 5, text: "Write tests", state: "todo" });
  });

  it("parses bullet checkboxes but not plain bullets/headings", () => {
    const steps = parsePlanChecklist(`## Steps\n- [ ] alpha\n- beta\n- [x] gamma\n`);
    expect(steps.map((s) => s.text)).toEqual(["alpha", "gamma"]);
    expect(steps[1]!.state).toBe("done");
  });

  it("returns empty for prose-only plans", () => {
    expect(parsePlanChecklist("Just do the thing.\n\nNo lists here.")).toEqual([]);
  });
});

describe("setStepStateInPlanMarkdown", () => {
  it("flips a step by 1-based index", () => {
    const res = setStepStateInPlanMarkdown(PLAN, { stepIndex: 1 }, "in_progress");
    expect(res.changed).toBe(true);
    expect(res.content).toContain("1. [~] Create login form");
    expect(res.step).toMatchObject({ index: 1, state: "in_progress" });
  });

  it("flips a step by text substring (case-insensitive)", () => {
    const res = setStepStateInPlanMarkdown(PLAN, { stepText: "supabase client" }, "done");
    expect(res.changed).toBe(true);
    expect(res.content).toContain("2. [x] Wire Supabase client");
  });

  it("adds a checkbox to plain numbered steps on first update", () => {
    const res = setStepStateInPlanMarkdown(PLAN, { stepIndex: 5 }, "in_progress");
    expect(res.changed).toBe(true);
    expect(res.content).toContain("5. [~] Write tests");
  });

  it("is a no-op for unknown steps", () => {
    const res = setStepStateInPlanMarkdown(PLAN, { stepIndex: 99 }, "done");
    expect(res.changed).toBe(false);
    expect(res.step).toBeUndefined();
    expect(res.content).toBe(PLAN);
  });

  it("reports unchanged when the state already matches", () => {
    const res = setStepStateInPlanMarkdown(PLAN, { stepIndex: 3 }, "done");
    expect(res.changed).toBe(false);
    expect(res.step).toBeDefined();
  });

  it("does not touch other lines", () => {
    const res = setStepStateInPlanMarkdown(PLAN, { stepIndex: 2 }, "done");
    expect(res.content).toContain("# Add auth");
    expect(res.content).toContain("1. [ ] Create login form");
    expect(res.content).toContain("4. [!] Configure OAuth redirect");
  });
});

describe("markAllChecklistStepsDone", () => {
  it("closes every open step", () => {
    const res = markAllChecklistStepsDone(PLAN);
    expect(res.changed).toBe(true);
    const steps = parsePlanChecklist(res.content);
    expect(steps.every((s) => s.state === "done")).toBe(true);
  });

  it("no-ops when everything is already done", () => {
    const allDone = "1. [x] a\n2. [x] b\n";
    expect(markAllChecklistStepsDone(allDone).changed).toBe(false);
  });
});
