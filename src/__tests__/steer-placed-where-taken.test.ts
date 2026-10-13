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

// QA #4 on build H: with one anchored step (the turn's run_command went to the
// background, so only "Checked background jobs" has a twin), the steer fell to
// the tail, after the answer.
describe("a steer with only one step to anchor to", () => {
  const parts: AssistantMessagePart[] = [
    { type: "thought", content: "…" },
    tool("background_jobs_0", "background_jobs"),
    { type: "markdown", content: "All 7 tests passed." },
  ];
  const anchors: StreamThreadItem[] = [
    { kind: "tool", id: "bj", toolName: "background_jobs", summary: "", status: "done", ts: 500 },
  ];
  it("goes before that step when it came first", () => {
    const steer: StreamThreadItem = { kind: "interjection", id: "interj-r2", text: "Also list failing tests.", rowKey: "r2", ts: 400 };
    const woven = weaveIpcItemsIntoParts({ before: parts, after: [], items: [steer], anchorsFrom: [...anchors, steer] });
    const kinds = woven.before.map((e) => (e.type === "part" ? e.part.type : e.item.kind));
    expect(kinds).toEqual(["thought", "interjection", "tool", "markdown"]);
    expect(woven.tail).toEqual([]);
  });
  it("goes right after it when it came later", () => {
    const steer: StreamThreadItem = { kind: "interjection", id: "interj-r3", text: "Thanks.", rowKey: "r3", ts: 600 };
    const woven = weaveIpcItemsIntoParts({ before: parts, after: [], items: [steer], anchorsFrom: [...anchors, steer] });
    const kinds = woven.before.map((e) => (e.type === "part" ? e.part.type : e.item.kind));
    expect(kinds).toEqual(["thought", "tool", "interjection", "markdown"]);
  });
});

// Same build-H turn: the command that went to the background has a thread card
// but no content tag, so with one anchor it landed AFTER the answer.
describe("an untagged card from before the first anchored step", () => {
  it("is drawn before that step, not after the answer", () => {
    const parts: AssistantMessagePart[] = [
      { type: "thought", content: "…" },
      tool("background_jobs_0", "background_jobs"),
      { type: "markdown", content: "All 7 tests passed." },
    ];
    const run: StreamThreadItem = { kind: "tool", id: "run", toolName: "run_command", summary: "Ran command", status: "done", ts: 762 };
    const steer: StreamThreadItem = { kind: "interjection", id: "interj-x", text: "Also list…", rowKey: "x", ts: 777 };
    const bj: StreamThreadItem = { kind: "tool", id: "bj", toolName: "background_jobs", summary: "", status: "done", ts: 787 };
    const woven = weaveIpcItemsIntoParts({ before: parts, after: [], items: [run, steer], anchorsFrom: [run, steer, bj] });
    const order = woven.before.map((e) => (e.type === "part" ? e.part.type : e.item.kind === "tool" ? e.item.toolName : e.item.kind));
    expect(order).toEqual(["thought", "run_command", "interjection", "tool", "markdown"]);
    expect(woven.tail).toEqual([]);
  });
});
