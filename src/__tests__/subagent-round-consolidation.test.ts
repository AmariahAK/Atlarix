/**
 * `consolidateSubagentRoundsInThread` had ZERO direct coverage, despite being
 * called from five sites in `stream-thread.ts` and twice more in
 * `AssistantMessageBody`. It is also the leading candidate for the open
 * "sub-agent round panel renders twice" report, which is exactly the wrong thing
 * to leave untested: the next person to investigate that will change this
 * function, and nothing would tell them what they broke.
 *
 * The duplicate it exists to merge is real and specific — one round carries the
 * constant `"subagent-round"` id from `mergeSubagentActivityIntoThread`'s
 * fallback, the other carries the live `roundId: ctx.turnId` from
 * `register-delegation-tools.ts`. Same round, two keys, two panels.
 */
import { describe, expect, it } from "vitest";
import {
  consolidateSubagentRoundsInThread,
  type StreamThreadItem,
  type SubAgentRunEntry,
} from "@/lib/chat/stream-thread";

const agent = (
  id: string,
  status: SubAgentRunEntry["status"] = "done",
): SubAgentRunEntry => ({
  id,
  agentType: "explorer",
  label: `explore ${id}`,
  status,
  nestedItems: [],
});

const round = (
  id: string,
  agents: SubAgentRunEntry[],
  ts: number,
): StreamThreadItem =>
  ({
    kind: "subagent_round",
    id,
    agents,
    status: "done",
    ts,
  }) as StreamThreadItem;

const thought = (id: string, ts: number): StreamThreadItem =>
  ({ kind: "thought", id, content: "thinking", ts }) as StreamThreadItem;

const roundsIn = (items: StreamThreadItem[]) =>
  items.filter((i) => i.kind === "subagent_round");

describe("consolidateSubagentRoundsInThread", () => {
  it("returns an empty thread untouched", () => {
    const items: StreamThreadItem[] = [];
    expect(consolidateSubagentRoundsInThread(items)).toBe(items);
  });

  it("is referentially identical with a single round — no needless atom write", () => {
    // The callers write the result into an atom; returning a new array for an
    // unchanged thread would re-render every consumer on every frame.
    const items = [thought("t1", 1), round("r1", [agent("a")], 2)];
    expect(consolidateSubagentRoundsInThread(items)).toBe(items);
  });

  it("is referentially identical with no rounds at all", () => {
    const items = [thought("t1", 1), thought("t2", 2)];
    expect(consolidateSubagentRoundsInThread(items)).toBe(items);
  });

  it("MERGES two rounds into one — the panel-renders-twice case", () => {
    // The exact shape from the report: the constant fallback id and the live
    // turn id, describing the same round.
    const merged = consolidateSubagentRoundsInThread([
      round("subagent-round", [agent("a"), agent("b")], 10),
      round("turn-42", [agent("c")], 20),
    ]);
    expect(roundsIn(merged)).toHaveLength(1);
  });

  it("keeps every agent across the merged rounds", () => {
    const merged = consolidateSubagentRoundsInThread([
      round("subagent-round", [agent("a"), agent("b")], 10),
      round("turn-42", [agent("c")], 20),
    ]);
    const ids = roundsIn(merged)[0]!
      .agents.map((a) => a.id)
      .sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("does not duplicate an agent present in both rounds", () => {
    const merged = consolidateSubagentRoundsInThread([
      round("subagent-round", [agent("a")], 10),
      round("turn-42", [agent("a"), agent("b")], 20),
    ]);
    expect(
      roundsIn(merged)[0]!
        .agents.map((a) => a.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("adopts the id of the round that still has a RUNNING agent", () => {
    // Not arbitrary: a live round's id is the one incoming stream frames are
    // keyed by, so adopting the finished one would orphan every later update.
    const merged = consolidateSubagentRoundsInThread([
      round("finished", [agent("a", "done")], 10),
      round("live", [agent("b", "running")], 20),
    ]);
    expect(roundsIn(merged)[0]!.id).toBe("live");
  });

  it("falls back to the LAST round's id when none is running", () => {
    const merged = consolidateSubagentRoundsInThread([
      round("first", [agent("a")], 10),
      round("second", [agent("b")], 20),
    ]);
    expect(roundsIn(merged)[0]!.id).toBe("second");
  });

  it("keeps the EARLIEST timestamp, so the panel does not jump forward", () => {
    const merged = consolidateSubagentRoundsInThread([
      round("r1", [agent("a")], 10),
      round("r2", [agent("b")], 99),
    ]);
    expect(roundsIn(merged)[0]!.ts).toBe(10);
  });

  it("preserves non-round items", () => {
    const merged = consolidateSubagentRoundsInThread([
      thought("t1", 1),
      round("r1", [agent("a")], 2),
      thought("t2", 3),
      round("r2", [agent("b")], 4),
    ]);
    expect(merged.filter((i) => i.kind === "thought").map((i) => i.id)).toEqual(
      ["t1", "t2"],
    );
  });

  it("moves the merged round to the END — documented, because it reorders", () => {
    // Worth pinning rather than discovering: the implementation rebuilds as
    // [everything that is not a round, merged]. If the panel's position in the
    // thread ever starts mattering, this is the line that has to change.
    const merged = consolidateSubagentRoundsInThread([
      round("r1", [agent("a")], 1),
      thought("t1", 2),
      round("r2", [agent("b")], 3),
    ]);
    expect(merged[merged.length - 1]!.kind).toBe("subagent_round");
  });

  it("merges three rounds, not just two", () => {
    const merged = consolidateSubagentRoundsInThread([
      round("r1", [agent("a")], 1),
      round("r2", [agent("b")], 2),
      round("r3", [agent("c")], 3),
    ]);
    expect(roundsIn(merged)).toHaveLength(1);
    expect(roundsIn(merged)[0]!.agents).toHaveLength(3);
  });
});
