/**
 * The QA sub-agent kind.
 *
 * QA is the first worker allowed a terminal and a browser, so what keeps it
 * honest is its PROFILE rather than its prompt. These pin the parts that would
 * silently degrade into "a writer that also tests things".
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS, listBuiltinAgents } from "@/lib/agents/builtin-agents";
import { agentIsWriter, subagentWillWrite } from "@/lib/agents/user-agents";

const qa = BUILTIN_AGENTS.qa!;

describe("qa built-in agent", () => {
  it("is registered and selectable as a subagent_type", () => {
    expect(qa).toBeDefined();
    expect(qa.name).toBe("qa");
    expect(listBuiltinAgents().map((a) => a.name)).toContain("qa");
  });

  it("cannot edit files — the whole point of a separate role", () => {
    // A QA worker that could edit would "fix" what it found, leaving the finding
    // unverifiable and the change unreviewed. Implementer writes; QA observes.
    expect(qa.tools).not.toContain("edit_file");
    expect(agentIsWriter(qa)).toBe(false);
  });

  it("gets the terminal and the browser, which no other worker does", () => {
    // Running the thing IS the observation — defer it and the worker learns
    // nothing and cannot iterate.
    expect(qa.tools).toContain("run_command");
    expect(qa.tools).toContain("browser_test");
    expect(qa.tools).toContain("browser_interact");
    // And the dev server's log, which is where an empty-bodied 500 actually is.
    expect(qa.tools).toContain("background_jobs");

    for (const other of ["explorer", "architect", "implementer"] as const) {
      expect(BUILTIN_AGENTS[other]!.tools).not.toContain("run_command");
      expect(BUILTIN_AGENTS[other]!.tools).not.toContain("browser_test");
    }
  });

  it("is on a build profile so its tools resolve — NOT so it can write", () => {
    // `mode` gates whether commands/browser tools are reachable at all. The
    // no-write property comes from the toolset plus the forced read-only sandbox,
    // never from the mode.
    expect(qa.mode).toBe("build");
    expect(agentIsWriter(qa)).toBe(false);
  });

  it("write:true cannot turn a qa spawn into a writer", () => {
    // Load-bearing and non-obvious: for a NAMED agent, subagentWillWrite returns
    // agentIsWriter(agent) and ignores the flag. Without that, a model passing
    // write:true would get a proposal set and the WRITER toolset — losing
    // run_command and gaining edit_file, i.e. exactly inverted.
    expect(
      subagentWillWrite({ write: true, subagentType: "qa", workspacePath: "" }),
    ).toBe(false);
    expect(
      subagentWillWrite({
        write: true,
        subagentType: "implementer",
        workspacePath: "",
      }),
    ).toBe(true);
  });

  it("its prompt refuses the failure modes that make QA worthless", () => {
    const p = qa.systemPrompt;
    // Invented findings are the single risk that decides whether this is loved or
    // switched off.
    expect(p).toMatch(/NO EVIDENCE, NO FINDING/i);
    // Finding nothing must be a blessed outcome, or the model will manufacture
    // something to look thorough.
    expect(p).toMatch(/all worked/i);
    // "Broken" and "untested" are different states.
    expect(p).toContain("NOT REACHED");
    // It must not be nudged toward load testing.
    expect(p).toMatch(/Do not load-test/i);
    // It must know it cannot write, so it stops trying to work around the sandbox.
    expect(p).toMatch(/CANNOT write to the workspace/i);
    // The prescribed return shape, which replaces a parser.
    expect(p).toContain("## Coverage");
    expect(p).toContain("## Findings");
  });

  it("is advertised where the model will actually see it", () => {
    // A kind nothing names is a kind nothing picks.
    expect(qa.description).toMatch(/running app/i);
  });
});
