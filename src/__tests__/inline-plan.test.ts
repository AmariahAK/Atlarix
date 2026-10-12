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

  it("checkbox steps count too", () => {
    expect(inlinePlan("**Plan**\n- [ ] Read the parser and its tests first, carefully.\n- [ ] Change the numbering to be per message.\n- [ ] Run the tests.")?.title).toBe("Plan");
  });

  it("a clarifying question with options is not a plan", () => {
    expect(inlinePlan("Before I plan this, which do you want?\n\n1. Keep the old flag working alongside the new one\n2. Replace it outright\n\nWhich one?")).toBeNull();
  });

  it("an answer with one step, or a short note, is not a plan", () => {
    expect(inlinePlan("1. Done.")).toBeNull();
    expect(inlinePlan("The parser lives in src/lib/chat/assistant-message-parts.ts and numbers tool calls per message; nothing to plan here.")).toBeNull();
  });
});
