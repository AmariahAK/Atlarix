/**
 * v10: live plan step progress — checklist parsing + checkbox rewriting.
 */
import { describe, it, expect } from "vitest";
import {
  extractExternalReason,
  formatPlanChecklistForPrompt,
  isActionableStepState,
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

  // v14.8.10: when index and text are BOTH given, the text is the model's
  // intent — a drifted index must never silently mark the wrong step.
  it("index wins when index and text agree", () => {
    const res = setStepStateInPlanMarkdown(
      PLAN,
      { stepIndex: 2, stepText: "supabase" },
      "done",
    );
    expect(res.changed).toBe(true);
    expect(res.step).toMatchObject({ index: 2, state: "done" });
  });

  it("text wins when index and text disagree (drifted index)", () => {
    // Index 1 is "Create login form", but the model MEANS the Supabase step.
    const res = setStepStateInPlanMarkdown(
      PLAN,
      { stepIndex: 1, stepText: "supabase client" },
      "done",
    );
    expect(res.changed).toBe(true);
    expect(res.step).toMatchObject({ index: 2, state: "done" });
    expect(res.content).toContain("1. [ ] Create login form"); // untouched
    expect(res.content).toContain("2. [x] Wire Supabase client");
  });

  it("matches despite trailing junk on step_text (malformed tool arg)", () => {
    // Observed in the wild: the model sent the step text verbatim plus a stray
    // "}" of tool-arg spillover. One-directional, unnormalised `includes()`
    // matched nothing, so the update silently no-op'd and the completion gate
    // held the turn open on a step that was actually done.
    const res = setStepStateInPlanMarkdown(
      PLAN,
      { stepIndex: 2, stepText: "Wire Supabase client}" },
      "done",
    );
    expect(res.changed).toBe(true);
    expect(res.step).toMatchObject({ index: 2, state: "done" });
    expect(res.content).toContain("2. [x] Wire Supabase client");
  });

  it("still finds by text alone when trailing junk is present", () => {
    const res = setStepStateInPlanMarkdown(
      PLAN,
      { stepText: "Add env vars.," },
      "todo",
    );
    expect(res.changed).toBe(true);
    expect(res.step).toMatchObject({ index: 3 });
  });

  it("not-found when both are given and the text matches nothing", () => {
    const res = setStepStateInPlanMarkdown(
      PLAN,
      { stepIndex: 1, stepText: "no such step anywhere" },
      "done",
    );
    expect(res.changed).toBe(false);
    expect(res.step).toBeUndefined();
    expect(res.content).toBe(PLAN);
  });

  it("whitespace-only step_text is treated as absent (index still works)", () => {
    const res = setStepStateInPlanMarkdown(
      PLAN,
      { stepIndex: 1, stepText: "   " },
      "in_progress",
    );
    expect(res.changed).toBe(true);
    expect(res.step).toMatchObject({ index: 1 });
  });
});

describe("markAllChecklistStepsDone", () => {
  it("closes actionable steps", () => {
    const res = markAllChecklistStepsDone("1. [ ] a\n2. [~] b\n");
    expect(res.changed).toBe(true);
    const steps = parsePlanChecklist(res.content);
    expect(steps.every((s) => s.state === "done")).toBe(true);
  });

  it("no-ops when everything is already done", () => {
    const allDone = "1. [x] a\n2. [x] b\n";
    expect(markAllChecklistStepsDone(allDone).changed).toBe(false);
  });

  // This safety net runs at the end of any Build turn that wrote a file. Flipping a
  // dispositioned step to `done` would delete the model's decision and tell the user
  // their step was finished when nobody did it.
  it("never closes blocked or external steps", () => {
    const res = markAllChecklistStepsDone(
      "1. [ ] mine\n2. [!] stuck here\n3. [@] Rotate the key — needs you: no cert on this machine\n",
    );
    const steps = parsePlanChecklist(res.content);
    expect(steps[0]!.state).toBe("done");
    expect(steps[1]!.state).toBe("blocked");
    expect(steps[2]!.state).toBe("external");
    expect(steps[2]!.text).toContain("needs you: no cert on this machine");
  });

  it("no-ops when the only open steps are blocked/external", () => {
    expect(
      markAllChecklistStepsDone("1. [x] a\n2. [!] b\n3. [@] c — needs you: x\n")
        .changed,
    ).toBe(false);
  });
});

describe("external steps", () => {
  const BASE = "1. [ ] Ship the build\n2. [ ] Rotate the signing key\n";

  it("parses the @ marker and round-trips the reason", () => {
    const res = setStepStateInPlanMarkdown(
      BASE,
      { stepText: "Rotate the signing key" },
      "external",
      "no cert on this machine",
    );
    expect(res.changed).toBe(true);
    expect(res.content).toContain(
      "2. [@] Rotate the signing key — needs you: no cert on this machine",
    );
    const steps = parsePlanChecklist(res.content);
    expect(steps[1]).toMatchObject({ index: 2, state: "external" });
    expect(extractExternalReason(steps[1]!.text)).toBe(
      "no cert on this machine",
    );
    // The returned step carries the REWRITTEN text, not the pre-append version.
    expect(res.step?.text).toContain("needs you:");
  });

  it("is idempotent — re-marking does not double the suffix", () => {
    const once = setStepStateInPlanMarkdown(
      BASE,
      { stepIndex: 2 },
      "external",
      "no cert",
    );
    const twice = setStepStateInPlanMarkdown(
      once.content,
      { stepIndex: 2 },
      "external",
      "no cert",
    );
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
    expect(once.content.match(/needs you:/g)).toHaveLength(1);
  });

  it("replaces the reason rather than appending a second one", () => {
    const once = setStepStateInPlanMarkdown(BASE, { stepIndex: 2 }, "external", "old");
    const twice = setStepStateInPlanMarkdown(
      once.content,
      { stepIndex: 2 },
      "external",
      "new reason",
    );
    expect(twice.content.match(/needs you:/g)).toHaveLength(1);
    expect(twice.content).toContain("needs you: new reason");
    expect(twice.content).not.toContain("old");
  });

  it("strips the reason when the step moves off external", () => {
    const ext = setStepStateInPlanMarkdown(BASE, { stepIndex: 2 }, "external", "no cert");
    const back = setStepStateInPlanMarkdown(ext.content, { stepIndex: 2 }, "in_progress");
    expect(back.changed).toBe(true);
    expect(back.content).toContain("2. [~] Rotate the signing key");
    expect(back.content).not.toContain("needs you");
  });

  it("still matches by step_text once a reason is attached", () => {
    const ext = setStepStateInPlanMarkdown(BASE, { stepIndex: 2 }, "external", "no cert");
    const done = setStepStateInPlanMarkdown(
      ext.content,
      { stepText: "Rotate the signing key" },
      "done",
    );
    expect(done.changed).toBe(true);
    expect(parsePlanChecklist(done.content)[1]!.state).toBe("done");
  });

  it("bullet checkboxes carry the marker too", () => {
    const res = setStepStateInPlanMarkdown(
      "- [ ] Publish to the store\n",
      { stepIndex: 1 },
      "external",
      "needs your developer account",
    );
    expect(res.content).toContain("- [@] Publish to the store — needs you:");
    expect(parsePlanChecklist(res.content)[0]!.state).toBe("external");
  });
});

describe("isActionableStepState", () => {
  it("counts only todo and in_progress", () => {
    expect(isActionableStepState("todo")).toBe(true);
    expect(isActionableStepState("in_progress")).toBe(true);
    expect(isActionableStepState("done")).toBe(false);
    expect(isActionableStepState("blocked")).toBe(false);
    expect(isActionableStepState("external")).toBe(false);
  });
});

describe("formatPlanChecklistForPrompt", () => {
  it("lists external steps separately and says nothing is left", () => {
    const steps = parsePlanChecklist(
      "1. [x] Build it\n2. [@] Rotate the key — needs you: no cert\n",
    );
    const out = formatPlanChecklistForPrompt(steps, "Ship v2")!;
    expect(out).toContain("1/2 steps done · 1 needs the user");
    expect(out).toContain("Needs the user");
    expect(out).toContain("do not re-attempt");
    expect(out).toContain("No step is left for you");
    expect(out).not.toContain("Remaining:");
  });

  it("keeps nudging while an actionable step remains", () => {
    const steps = parsePlanChecklist("1. [ ] Build it\n2. [@] Rotate — needs you: x\n");
    const out = formatPlanChecklistForPrompt(steps)!;
    expect(out).toContain("Remaining: 1. Build it");
    expect(out).not.toContain("No step is left for you");
  });

  it("still uses the all-done wording when every step really is done", () => {
    const steps = parsePlanChecklist("1. [x] a\n2. [x] b\n");
    expect(formatPlanChecklistForPrompt(steps)!).toContain(
      "All steps are marked done",
    );
  });
});
