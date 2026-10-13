import { describe, expect, it } from "vitest";
import { inlinePlan } from "@/cli/agent/inline-plan";

describe("a Plan-mode reply that is a plan", () => {
  it("is found, titled by its heading, without the model's own comment", () => {
    const p = inlinePlan(
      "## Add a --version flag\n\n1. Read the CLI entry and find where flags are parsed.\n2. Add `--version` printing the package version.\n3. Add a test and run the suite. <!--plan:created-->",
    );
    expect(p?.title).toBe("Add a --version flag");
    expect(p?.content).not.toContain("<!--");
  });

  it("checkbox steps count too; a generic 'Plan' heading gives way to the first step", () => {
    expect(inlinePlan("**Plan**\n- [ ] Read the parser and its tests first, carefully.\n- [ ] Change the numbering to be per message.\n- [ ] Run the tests.")?.title).toBe("Read the parser and its tests first, carefully");
  });

  it("a clarifying question with options is not a plan", () => {
    expect(inlinePlan("Before I plan this, which do you want?\n\n1. Keep the old flag working alongside the new one\n2. Replace it outright\n\nWhich one?")).toBeNull();
  });

  it("an answer with one step, or a short note, is not a plan", () => {
    expect(inlinePlan("1. Done.")).toBeNull();
    expect(inlinePlan("The parser lives in src/lib/chat/assistant-message-parts.ts and numbers tool calls per message; nothing to plan here.")).toBeNull();
  });
});

describe("what an inline plan keeps (QA #53)", () => {
  it("only the plan: not the command output before it or the note after it", () => {
    const p = inlinePlan(
      "Command output: README.md src done\n\nHere's a short plan to add a --version flag:\n\n1. Find where the CLI parses its flags.\n2. Print the package version on --version and exit 0.\n   (read it from package.json)\n3. Add a test.\n\nI've left the session plan card untouched per your instruction.",
    )!;
    expect(p.title).toBe("Add a --version flag");
    expect(p.content.startsWith("Here's a short plan")).toBe(true);
    expect(p.content).toContain("(read it from package.json)");
    expect(p.content.trim().endsWith("3. Add a test.")).toBe(true);
    expect(p.content).not.toContain("Command output");
    expect(p.content).not.toContain("left the session plan card");
  });

  it("a bare 'Plan:' intro takes its title from the first step", () => {
    const p = inlinePlan("Plan:\n1. Read the parser and its tests before changing anything.\n2. Number tool calls per message.\n3. Run the suite.")!;
    expect(p.title).toBe("Read the parser and its tests before changing anything");
  });
});
