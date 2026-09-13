/**
 * THE EGRESS RULE.
 *
 * This file exists for one assertion: a page the agent read must not leave the
 * device. Everything else here is in service of being able to state that
 * directly rather than inferring it from what a request happened to contain.
 *
 * The rule is enforced twice — by `syncableRows` below, and by
 * `content_length_by_role` on `conversation_messages`, which caps a tool row at
 * 200 characters. Either alone is a rule that holds until someone writes a
 * second caller.
 */

import { describe, expect, it } from "vitest";
import type { CoreMessage } from "../core/client";
import { compactionMarker } from "../context/compact";
import { labelsFrom, syncableRows } from "./sync";

/** What a real conversation looks like: a question, a page read, an answer. */
const PAGE_TEXT =
  "Account holder: Amariah. Balance: 4,182.55. Recent transactions: " +
  "x".repeat(40_000);

const conversation: CoreMessage[] = [
  { role: "user", content: "what is my balance?" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "read_page", arguments: '{"tab_id":9}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "c1", content: PAGE_TEXT },
  { role: "assistant", content: "Your balance is 4,182.55." },
];

describe("what leaves the device", () => {
  it("never carries a tool result, however it is labelled", () => {
    // THE ASSERTION THE WHOLE FEATURE RESTS ON. A page read is the contents of
    // whatever the user was looking at — an inbox, a bank dashboard, a medical
    // portal. It being their own row does not change what it is.
    const rows = syncableRows(conversation, () => "Reading my-bank.example");
    const everything = rows.map((r) => r.content).join("\n");
    expect(everything).not.toContain("4,182.55 ");
    expect(everything).not.toContain(PAGE_TEXT);
    expect(everything).not.toContain("x".repeat(50));
  });

  it("sends a tool call as its label and nothing else", () => {
    const rows = syncableRows(conversation, () => "Reading my-bank.example");
    const tool = rows.find((r) => r.role === "tool_label");
    expect(tool?.content).toBe("Reading my-bank.example");
  });

  it("still sends a label when there is none to send", () => {
    // A gap in the transcript is worse than a generic label: the synced
    // conversation would read as though the assistant answered out of nowhere.
    const rows = syncableRows(conversation);
    expect(rows.find((r) => r.role === "tool_label")?.content).toBe(
      "Used a tool",
    );
  });

  it("cannot smuggle a page through the label", () => {
    // Mirrors `content_length_by_role`. Clipped here so an over-long label is a
    // shorter label rather than a rejected write — and the database refuses it
    // either way.
    const rows = syncableRows(conversation, () => PAGE_TEXT);
    const tool = rows.find((r) => r.role === "tool_label");
    expect(tool?.content.length).toBeLessThanOrEqual(200);
  });

  it("sends what people actually said, in full", () => {
    const rows = syncableRows(conversation);
    expect(rows.map((r) => r.content)).toContain("what is my balance?");
    expect(rows.map((r) => r.content)).toContain("Your balance is 4,182.55.");
  });

  it("sends a compaction summary as its body, without the marker scaffolding", () => {
    // The `[COMPACTION MARKER] gen=N` wrapper and the recovery hint are local
    // bookkeeping. Synced, they would read as something the user typed.
    const rows = syncableRows([compactionMarker("## Goal\n- check balance", 2)]);
    expect(rows[0].role).toBe("compaction");
    expect(rows[0].content).toBe("## Goal\n- check balance");
    expect(rows[0].content).not.toContain("COMPACTION MARKER");
    expect(rows[0].content).not.toContain("recall");
  });
});

describe("positions", () => {
  it("keeps the position of the ORIGINAL transcript", () => {
    // Two devices syncing the same conversation upsert on
    // `(conversation_id, seq)`. A position that shifted when a row was skipped
    // would have one device overwrite another's rows with different content.
    const rows = syncableRows(conversation);
    expect(rows.map((r) => r.seq)).toEqual([0, 2, 3]);
  });

  it("skips an assistant message that was only a tool call", () => {
    // It has no content of its own; its tool call is already represented by the
    // label row that follows.
    expect(syncableRows(conversation).map((r) => r.role)).toEqual([
      "user",
      "tool_label",
      "assistant",
    ]);
  });

  it("skips an empty user message rather than syncing a blank row", () => {
    expect(syncableRows([{ role: "user", content: "   " }])).toEqual([]);
  });
});

describe("labelsFrom", () => {
  it("falls back to the tool's own name, which is a usable label", () => {
    expect(labelsFrom(conversation).get("c1")).toBe("read_page");
  });
});
