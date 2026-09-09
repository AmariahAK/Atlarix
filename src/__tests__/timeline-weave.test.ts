import { describe, expect, it } from "vitest";
import { weaveIpcItemsIntoParts } from "@/lib/chat/timeline-weave";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";

/**
 * W7 (v14.8.11): IPC-only cards (compaction/background) weave into the
 * content timeline at their timestamps instead of pinning to the tail.
 * Unanchorable items keep today's tail placement — a heuristic miss can
 * never render worse than the pre-fix behavior.
 */

const md = (content: string): AssistantMessagePart => ({
  type: "markdown",
  content,
});
const toolPart = (toolName: string): AssistantMessagePart => ({
  type: "tool",
  id: `part-${toolName}`,
  toolName,
  status: "success",
});
const threadTool = (toolName: string, ts: number): StreamThreadItem =>
  ({
    kind: "tool",
    id: `thr-${toolName}-${ts}`,
    toolName,
    status: "done",
    label: toolName,
    ts,
  }) as unknown as StreamThreadItem;
const bg = (id: string, ts: number): StreamThreadItem =>
  ({
    kind: "background",
    id,
    label: "Context compressed",
    status: "done",
    ts,
  }) as unknown as StreamThreadItem;
const idOf = (i: StreamThreadItem): string => (i as { id: string }).id;

describe("weaveIpcItemsIntoParts", () => {
  it("a compaction card lands between the two tools whose ts bracket it", () => {
    const before = [
      md("intro"),
      toolPart("read_file"),
      toolPart("edit_file"),
      md("done"),
    ];
    const anchors = [
      threadTool("read_file", 100),
      threadTool("edit_file", 300),
    ];
    const item = bg("compact-1", 200);
    const { before: woven, tail } = weaveIpcItemsIntoParts({
      before,
      after: [],
      items: [item],
      anchorsFrom: anchors,
    });
    expect(tail).toEqual([]);
    const order = woven.map((e) =>
      e.type === "part"
        ? e.part.type === "tool"
          ? e.part.toolName
          : "md"
        : idOf(e.item),
    );
    expect(order).toEqual(["md", "read_file", "compact-1", "edit_file", "md"]);
  });

  it("an item outside every bracket keeps tail placement", () => {
    const before = [toolPart("read_file"), toolPart("edit_file")];
    const anchors = [
      threadTool("read_file", 100),
      threadTool("edit_file", 300),
    ];
    const early = bg("too-early", 50);
    const late = bg("too-late", 900);
    const { tail } = weaveIpcItemsIntoParts({
      before,
      after: [],
      items: [early, late],
      anchorsFrom: anchors,
    });
    expect(tail.map(idOf)).toEqual(["too-early", "too-late"]);
  });

  it("zero anchors → everything tails (current behavior preserved)", () => {
    const { before, tail } = weaveIpcItemsIntoParts({
      before: [md("prose only")],
      after: [],
      items: [bg("c", 10)],
      anchorsFrom: [],
    });
    expect(before).toEqual([{ type: "part", part: md("prose only") }]);
    expect(tail.map(idOf)).toEqual(["c"]);
  });

  it("repeated tool names anchor by occurrence order", () => {
    const before = [
      toolPart("read_file"),
      toolPart("read_file"),
      toolPart("read_file"),
    ];
    const anchors = [
      threadTool("read_file", 100),
      threadTool("read_file", 300),
      threadTool("read_file", 500),
    ];
    const item = bg("mid", 350);
    const { before: woven, tail } = weaveIpcItemsIntoParts({
      before,
      after: [],
      items: [item],
      anchorsFrom: anchors,
    });
    expect(tail).toEqual([]);
    const idx = woven.findIndex((e) => e.type === "thread");
    expect(idx).toBe(2); // after the 2nd read_file part, before the 3rd
  });

  it("items weave into the after-split side too", () => {
    const after = [toolPart("grep"), toolPart("edit_file")];
    const anchors = [threadTool("grep", 100), threadTool("edit_file", 400)];
    const { after: wovenAfter, tail } = weaveIpcItemsIntoParts({
      before: [],
      after,
      items: [bg("mid", 250)],
      anchorsFrom: anchors,
    });
    expect(tail).toEqual([]);
    expect(
      wovenAfter.map((e) => (e.type === "thread" ? idOf(e.item) : "part")),
    ).toEqual(["part", "mid", "part"]);
  });

  it("subagent_round items never weave inline", () => {
    const before = [toolPart("read_file"), toolPart("edit_file")];
    const anchors = [
      threadTool("read_file", 100),
      threadTool("edit_file", 300),
    ];
    const round = {
      kind: "subagent_round",
      id: "round-1",
      agents: [],
      status: "done",
      ts: 200,
    } as unknown as StreamThreadItem;
    const { tail } = weaveIpcItemsIntoParts({
      before,
      after: [],
      items: [round],
      anchorsFrom: anchors,
    });
    expect(tail.map(idOf)).toEqual(["round-1"]);
  });

  it("stable output: multiple items in one gap keep chronological order", () => {
    const before = [toolPart("a"), toolPart("b")];
    const anchors = [threadTool("a", 100), threadTool("b", 500)];
    const { before: woven } = weaveIpcItemsIntoParts({
      before,
      after: [],
      items: [bg("second", 300), bg("first", 200)],
      anchorsFrom: anchors,
    });
    const threadIds = woven
      .filter((e) => e.type === "thread")
      .map((e) => idOf((e as { item: StreamThreadItem }).item));
    expect(threadIds).toEqual(["first", "second"]);
  });
});
