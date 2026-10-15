import { describe, expect, it } from "vitest";
import {
  CANCEL_MARK,
  collapseCancelled,
  markInterrupted,
} from "@/cli/agent/transcript";

/**
 * A turn stopped before any output is stored as the stop mark alone (QA 15.7.1
 * #2). Reopened (`atlarix -c`), it drew the prompt with nothing under it: the
 * "Interrupted" note now goes under your message.
 */
describe("a reopened chat with a turn stopped before any output", () => {
  it("drops the empty reply and marks your message as interrupted", () => {
    const interrupted = new Set<string>();
    const out = collapseCancelled(
      [
        { id: 1, role: "user", content: "What is 6+6?" },
        { id: 2, role: "assistant", content: "12" },
        { id: 3, role: "user", content: "Write an essay about glaciers." },
        { id: 4, role: "assistant", content: CANCEL_MARK },
      ],
      interrupted,
    );
    expect(out.map((m) => m.id)).toEqual([1, 2, 3]);
    expect([...interrupted]).toEqual(["3"]);
    const cells = markInterrupted(
      [
        {
          kind: "user",
          id: "3:u",
          text: "Write an essay about glaciers.",
        } as never,
      ],
      interrupted,
    );
    expect(cells.at(-1)).toMatchObject({
      kind: "notice",
      text: "Interrupted. Tell Atlarix what to do instead.",
    });
  });

  it("leaves a stopped reply with text as it was (its own note)", () => {
    const interrupted = new Set<string>();
    const out = collapseCancelled(
      [
        { id: 1, role: "user", content: "Essay?" },
        { id: 2, role: "assistant", content: `Glaciers are\n\n${CANCEL_MARK}` },
      ],
      interrupted,
    );
    expect(out.map((m) => [m.id, m.content])).toEqual([
      [1, "Essay?"],
      [2, "Glaciers are"],
    ]);
    expect(interrupted.size).toBe(0);
  });
});
