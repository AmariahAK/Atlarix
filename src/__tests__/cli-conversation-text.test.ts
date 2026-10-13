import { describe, expect, it } from "vitest";
import { conversationText } from "@/cli/agent/btw";
import type { Cell } from "@/cli/agent/transcript";

describe("the conversation as the recap and /btw read it", () => {
  it("says how steps and turns ended, so a stopped turn isn't recapped as still going (QA E5)", () => {
    const tool = (id: string, status: "success" | "interrupted" | "error", target: string) =>
      ({ kind: "tool", id, tool: { verb: "Read", target, status } }) as unknown as Cell;
    const text = conversationText([
      { kind: "user", id: "u1", text: "read the files one by one" },
      tool("t1", "success", "src/math.ts"),
      tool("t2", "interrupted", "src/index.ts"),
      { kind: "footer", id: "f1", text: "Build · 12s", interrupted: true },
      { kind: "notice", id: "n1", level: "info", text: "Compacted the conversation" },
      { kind: "user", id: "u2", text: "what is 2+2?" },
      { kind: "markdown", id: "m2", text: "4" },
    ]);
    expect(text).toContain("[Read src/math.ts]");
    expect(text).toContain("[Read src/index.ts (stopped)]");
    expect(text).toContain("[The user stopped this turn.]");
    expect(text).toContain("[Compacted the conversation]");
    expect(text.trim().endsWith("Atlarix: 4")).toBe(true);
  });
});
