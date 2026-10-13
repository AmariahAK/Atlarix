/**
 * QA (app) #4: a message sent while a turn ran showed above the whole answer
 * (it is stored as its own user row in front of the reply). The reply's
 * thread now holds it where the agent took it, and the weave places it
 * between the steps it came between.
 */
import { describe, it, expect } from "vitest";
import { weaveIpcItemsIntoParts } from "@/lib/chat/timeline-weave";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";

const tool = (id: string, toolName: string): AssistantMessagePart => ({ type: "tool", id, toolName, status: "success" });

describe("a steer in a finished reply", () => {
  it("sits between the steps it came between", () => {
    const parts: AssistantMessagePart[] = [
      tool("edit_file_0", "edit_file"),
      tool("edit_file_1", "edit_file"),
      tool("run_command_0", "run_command"),
    ];
    const thread: StreamThreadItem[] = [
      { kind: "tool", id: "a", toolName: "edit_file", summary: "", status: "done", ts: 100 },
      { kind: "tool", id: "b", toolName: "edit_file", summary: "", status: "done", ts: 200 },
      { kind: "tool", id: "c", toolName: "run_command", summary: "", status: "done", ts: 300 },
    ];
    const steer: StreamThreadItem = { kind: "interjection", id: "interj-r1", text: "Also add a test for n=1.", rowKey: "r1", ts: 150 };
    const woven = weaveIpcItemsIntoParts({ before: parts, after: [], items: [steer], anchorsFrom: [...thread, steer] });
    const order = woven.before.map((e) => (e.type === "part" ? e.part.type === "tool" && e.part.id : e.item.kind));
    expect(order).toEqual(["edit_file_0", "interjection", "edit_file_1", "run_command_0"]);
    expect(woven.tail).toEqual([]);
  });
});
