import { describe, expect, it } from "vitest";
import {
  microcompactStaleToolOutputs,
  countMessagesTokens,
} from "@/lib/context/compaction";

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
    msgs.push({
      id: id++,
      role: "assistant",
      content: toolResult(`turn-${t}`),
    });
  }
  return msgs;
}

/** Exact tokens of the newest `n` tool results in this conversation. */
function newestResultTokens(
  msgs: { role: string; content: string }[],
  n: number,
): number {
  const results = msgs.filter((m) => m.role === "assistant");
  return countMessagesTokens(
    results.slice(-n).map((m) => ({ content: m.content })),
  );
}

describe("microcompactStaleToolOutputs", () => {
  /**
   * The keep-window is TOKENS, not turns. It was `keepRecentTurns = 3`, which is
   * why it did nothing on the session that prompted the change: that session had
   * two turns, so all 41,000 of its tokens counted as "recent" and none were
   * dropped. A budget cannot be fooled by a conversation being short and enormous.
   */
  it("drops tool outputs older than the keep-window, keeps recent ones intact", () => {
    const msgs = conversation(6);
    // Exactly enough room for the four newest results, so the two oldest must go.
    // Measured from the fixture rather than assumed: the labels differ in length,
    // so a per-result estimate multiplied out is off by enough to drop a third.
    const keep = newestResultTokens(msgs, 4);
    const { messages, tokensDropped } = microcompactStaleToolOutputs(
      msgs,
      keep,
    );

    expect(tokensDropped).toBeGreaterThan(0);

    const dropped = messages.filter((m) =>
      m.content.includes("omitted to save space"),
    );
    expect(dropped).toHaveLength(2);
    // Stage 3c: the marker must NOT tell the model to re-read (that drove the loop).
    for (const m of dropped) {
      expect(m.content.toLowerCase()).not.toContain("re-read");
      expect(m.content.toLowerCase()).not.toContain("re-run");
    }

    // Recent turns keep their full tool output; old ones are gone.
    expect(messages.at(-1)!.content).toContain("turn-6");
    expect(messages.find((m) => m.content.includes("turn-3"))).toBeTruthy();
    expect(messages.find((m) => m.content.includes("turn-1"))).toBeUndefined();
    expect(messages.find((m) => m.content.includes("turn-2"))).toBeUndefined();
  });

  it("is a no-op when everything fits the keep-window", () => {
    const msgs = conversation(2);
    const keep = newestResultTokens(msgs, 2) * 10;
    const { messages, tokensDropped } = microcompactStaleToolOutputs(
      msgs,
      keep,
    );
    expect(tokensDropped).toBe(0);
    expect(messages).toEqual(msgs);
  });

  it("never drops protected content (e.g. files written)", () => {
    const msgs = [
      { id: 1, role: "user", content: "a" },
      {
        id: 2,
        role: "assistant",
        content: toolResult("old"),
        filesWritten: ["x.ts"],
      },
      { id: 3, role: "user", content: "b" },
      { id: 4, role: "user", content: "c" },
      { id: 5, role: "user", content: "d" },
      { id: 6, role: "user", content: "e" },
    ];
    const { tokensDropped } = microcompactStaleToolOutputs(msgs, 3);
    expect(tokensDropped).toBe(0); // the only old tool result is protected
  });
});
