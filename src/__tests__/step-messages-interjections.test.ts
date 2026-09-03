/**
 * Tagged vs UNTAGGED on the step-message seam.
 *
 * This is the one invariant the mid-turn-message feature rests on, and it is
 * invisible on the wire if it is wrong: every harness injection is wrapped in
 * `<system-reminder>` precisely so a recency-biased model does not read a nudge
 * as a fresh user request. A message the user actually typed is the opposite
 * case — it IS real user input — so it must arrive UNWRAPPED. Nothing else in
 * the app sends an untagged injection, which is exactly why it needs pinning.
 */

import { describe, it, expect } from "vitest";
import { buildStepMessages } from "@/lib/streaming/step-messages";
import { systemReminder } from "@/lib/streaming/system-reminder";

const history = [{ role: "user" as const, content: "original request" }];

describe("buildStepMessages — interjections", () => {
  it("returns the SAME array (changed:false) when there is nothing to add", () => {
    const r = buildStepMessages({
      messages: history,
      injected: "",
      interjections: null,
      tag: systemReminder,
    });
    expect(r.changed).toBe(false);
    // Identity matters: `prepareStep` returns undefined on this, keeping the
    // step byte-identical for the prompt cache.
    expect(r.messages).toBe(history);
  });

  it("wraps a harness block in the system-reminder tag", () => {
    const r = buildStepMessages({
      messages: history,
      injected: "a background job finished",
      interjections: null,
      tag: systemReminder,
    });
    const last = r.messages[r.messages.length - 1] as { content: string };
    expect(last.content).toContain("<system-reminder>");
    expect(r.changed).toBe(true);
  });

  it("delivers a user's mid-turn message UNTAGGED and verbatim", () => {
    const r = buildStepMessages({
      messages: history,
      injected: "",
      interjections: [{ text: "actually use Postgres" }],
      tag: systemReminder,
    });
    expect(r.changed).toBe(true);
    const last = r.messages[r.messages.length - 1] as {
      role: string;
      content: string;
    };
    expect(last.role).toBe("user");
    expect(last.content).toBe("actually use Postgres");
    expect(last.content).not.toContain("system-reminder");
  });

  it("keeps the harness block tagged while the user's messages stay untagged", () => {
    const r = buildStepMessages({
      messages: history,
      injected: "a sub-agent finished",
      interjections: [{ text: "and add tests" }],
      tag: systemReminder,
    });
    const [, harness, mine] = r.messages as { content: string }[];
    expect(harness!.content).toContain("<system-reminder>");
    expect(mine!.content).toBe("and add tests");
    // The harness block comes FIRST so the note explaining the untagged
    // message(s) is read before them.
    expect(r.messages).toHaveLength(3);
  });

  it("emits several messages separately, oldest first", () => {
    const r = buildStepMessages({
      messages: history,
      injected: "",
      interjections: [
        { text: "use Postgres" },
        { text: "no wait, SQLite" },
      ],
      tag: systemReminder,
    });
    // SEPARATE, not joined: order carries the meaning of a correction, and a
    // single blob invites the model to act on the last line alone.
    expect((r.messages as { content: string }[]).slice(1).map((m) => m.content)).toEqual([
      "use Postgres",
      "no wait, SQLite",
    ]);
  });

  it("never mutates the caller's history array", () => {
    const before = [...history];
    buildStepMessages({
      messages: history,
      injected: "x",
      interjections: [{ text: "y" }],
      tag: systemReminder,
    });
    expect(history).toEqual(before);
  });
});
