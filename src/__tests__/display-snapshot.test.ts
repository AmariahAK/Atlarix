import { describe, expect, it } from "vitest";
import {
  buildDisplaySnapshotV1,
  parseDisplaySnapshot,
} from "@/lib/chat/display-snapshot";

const RAW =
  'A<think>r1</think><atlarix-tool-call tool="read_file"></atlarix-tool-call><think>r2</think>B';

describe("display-snapshot interleavedContent (message ordering fix)", () => {
  it("round-trips interleavedContent through build → stringify → parse", () => {
    const snap = buildDisplaySnapshotV1({
      completedThread: [],
      interleavedContent: RAW,
    });
    expect(snap).not.toBeNull();
    expect(snap!.interleavedContent).toBe(RAW);
    const reparsed = parseDisplaySnapshot(JSON.stringify(snap));
    expect(reparsed?.interleavedContent).toBe(RAW);
  });

  it("creates a snapshot when ONLY interleavedContent is present (no thread)", () => {
    const snap = buildDisplaySnapshotV1({
      completedThread: [],
      interleavedContent: RAW,
    });
    expect(snap?.version).toBe(1);
    expect(snap?.completedThread).toEqual([]);
  });

  it("returns null when everything is empty", () => {
    expect(
      buildDisplaySnapshotV1({ completedThread: [], interleavedContent: "  " }),
    ).toBeNull();
    expect(buildDisplaySnapshotV1({ completedThread: [] })).toBeNull();
  });

  it("omits interleavedContent when blank but keeps a thread-only snapshot", () => {
    const snap = buildDisplaySnapshotV1({
      completedThread: [
        { kind: "thought", id: "t1", content: "hi", ts: 1 } as never,
      ],
      interleavedContent: "",
    });
    expect(snap).not.toBeNull();
    expect("interleavedContent" in (snap as object)).toBe(false);
  });
});

// QA #49 on build I: a plain reply ("pong": no steps, no thinking) stored no
// snapshot at all, so after a reopen its header named the CURRENT model.
describe("a reply with nothing but text", () => {
  it("still keeps the model it ran on", () => {
    const model = { provider: "z-ai", name: "glm-5.3" };
    const snap = buildDisplaySnapshotV1({ completedThread: [], model });
    expect(snap?.model).toEqual(model);
  });
  it("stores nothing when there is no model either (control)", () => {
    expect(buildDisplaySnapshotV1({ completedThread: [] })).toBeNull();
  });
});
