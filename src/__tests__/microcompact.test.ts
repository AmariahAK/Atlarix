import { describe, expect, it } from "vitest";
import { microcompactStaleToolOutputs } from "@/lib/context/compaction";

/** A chunk that `contentLooksLikeToolResult` recognizes. */
function toolResult(label: string): string {
  return `<atlarix-tool-result tool="read_file">${label} ${"x".repeat(400)}</atlarix-tool-result>`;
}

/** Build N user→assistant(tool-result) turns, oldest first. */
function conversation(turns: number) {
  const msgs: { id: number; role: string; content: string }[] = [];
  let id = 1;
  for (let t = 1; t <= turns; t++) {
    msgs.push({ id: id++, role: "user", content: `request ${t}` });
    msgs.push({ id: id++, role: "assistant", content: toolResult(`turn-${t}`) });
  }
  return msgs;
}

describe("microcompactStaleToolOutputs", () => {
  it("drops tool outputs older than the keep-window, keeps recent ones intact", () => {
    // With keep=3, a tool result drops only if >3 user turns follow it.
    const msgs = conversation(6); // drops turns 1 & 2, keeps 3..6
    const { messages, tokensDropped } = microcompactStaleToolOutputs(msgs, 3);

    expect(tokensDropped).toBeGreaterThan(0);

    const dropped = messages.filter((m) => m.content.includes("tool output dropped"));
    expect(dropped).toHaveLength(2);

    // Recent turns keep their full tool output; old ones are gone.
    expect(messages.at(-1)!.content).toContain("turn-6");
    expect(messages.find((m) => m.content.includes("turn-3"))).toBeTruthy();
    expect(messages.find((m) => m.content.includes("turn-1"))).toBeUndefined();
    expect(messages.find((m) => m.content.includes("turn-2"))).toBeUndefined();
  });

  it("is a no-op for short conversations within the keep-window", () => {
    const msgs = conversation(2);
    const { messages, tokensDropped } = microcompactStaleToolOutputs(msgs, 3);
    expect(tokensDropped).toBe(0);
    expect(messages).toEqual(msgs);
  });

  it("never drops protected content (e.g. files written)", () => {
    const msgs = [
      { id: 1, role: "user", content: "a" },
      { id: 2, role: "assistant", content: toolResult("old"), filesWritten: ["x.ts"] },
      { id: 3, role: "user", content: "b" },
      { id: 4, role: "user", content: "c" },
      { id: 5, role: "user", content: "d" },
      { id: 6, role: "user", content: "e" },
    ];
    const { tokensDropped } = microcompactStaleToolOutputs(msgs, 3);
    expect(tokensDropped).toBe(0); // the only old tool result is protected
  });
});
