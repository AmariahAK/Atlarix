/**
 * v13.9.0: an AUTO-APPROVED overwrite never produces a permission preview, so
 * its old/new content arrives over the display-only `chat:stream:write-preview`
 * channel. `mergeWritePreviewIntoThread` stashes that content onto the matching
 * running tool item's `toolArgs`, and `buildToolExpandView` renders an accurate
 * red/green diff from those args — at ZERO model tokens. A full overwrite must
 * show REMOVED lines, not all-added.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDefaultStore } from "jotai";
import { streamThreadByChatIdAtom } from "@/atoms/chatAtoms";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";
import { mergeWritePreviewIntoThread } from "@/hooks/useStreamChat";
import { buildToolExpandView } from "@/lib/chat/tool-expand-view";

const CHAT_ID = 4242;

function seedRunningTool(path: string): void {
  const item: StreamThreadItem = {
    kind: "tool",
    id: "tool-1",
    toolName: "edit_file",
    summary: "Writing file",
    status: "running",
    ts: 1,
    toolArgs: { path, operation: "write" },
  };
  getDefaultStore().set(streamThreadByChatIdAtom, new Map([[CHAT_ID, [item]]]));
}

function currentToolArgs(): Record<string, unknown> | undefined {
  const cur = getDefaultStore().get(streamThreadByChatIdAtom).get(CHAT_ID);
  const tool = cur?.find((i) => i.kind === "tool") as
    | Extract<StreamThreadItem, { kind: "tool" }>
    | undefined;
  return tool?.toolArgs;
}

describe("mergeWritePreviewIntoThread (auto-approved overwrite)", () => {
  beforeEach(() => {
    getDefaultStore().set(streamThreadByChatIdAtom, new Map());
  });

  it("merges old+new content onto the matching tool item", () => {
    seedRunningTool("src/x.ts");
    mergeWritePreviewIntoThread(
      CHAT_ID,
      "src/x.ts",
      "update",
      "line a\nline b\nline c\n",
      "line a\nCHANGED\nline c\n",
    );
    const args = currentToolArgs();
    expect(args?.old_content).toBe("line a\nline b\nline c\n");
    expect(args?.content).toBe("line a\nCHANGED\nline c\n");
    expect(args?.operation).toBe("update");
  });

  it("renders a full overwrite as a diff WITH removed lines (not all-added)", () => {
    seedRunningTool("src/x.ts");
    const oldContent = "old 1\nold 2\nold 3";
    const newContent = "new 1\nnew 2";
    mergeWritePreviewIntoThread(
      CHAT_ID,
      "src/x.ts",
      "update",
      oldContent,
      newContent,
    );

    const view = buildToolExpandView(
      "edit_file",
      currentToolArgs(),
      JSON.stringify({
        success: true,
        path: "src/x.ts",
        operation: "update",
        added: 2,
        removed: 3,
      }),
      "done",
    );
    expect(view.kind).toBe("diff");
    if (view.kind === "diff") {
      expect(view.oldContent).toContain("old 1");
      expect(view.newContent).toContain("new 1");
      expect(view.removedCount).toBeGreaterThan(0); // a real overwrite shows red
    }
  });

  it("falls back to the most-recent running tool when no path matches", () => {
    seedRunningTool("src/x.ts");
    // Preview path differs (e.g. normalized) — should still land on the running tool.
    mergeWritePreviewIntoThread(CHAT_ID, "./src/x.ts", "update", "a\n", "b\n");
    const args = currentToolArgs();
    expect(args?.content).toBe("b\n");
  });
});

/**
 * QA (app) #6, reproduced on a real build: the Edited-file card diffed the
 * model's SNIPPETS (numbered from 1), and an auto-approved edit's card said
 * only "1 line written". The full old/new file was merged onto the running
 * card, but the card's diff view is built when the tool finishes, from the
 * finishing item — which carries the model's own args (snippets) or none —
 * and that replaced the merged content.
 */
import { upsertStreamThreadItem } from "@/lib/chat/stream-thread";

describe("a write card that finishes after its preview arrived", () => {
  const OLD = "# tally\n\nCounts words. `npm test` runs the tests.\n";
  const NEW = "# tally\n\nCounts the words in a text. `npm test` runs the tests.\n";
  const RESULT = JSON.stringify({ success: true, path: "README.md", operation: "update", added: 1, removed: 1 });

  function finish(toolArgs: Record<string, unknown> | undefined) {
    const store = getDefaultStore();
    const cur = store.get(streamThreadByChatIdAtom).get(CHAT_ID)!;
    const done: StreamThreadItem = {
      kind: "tool",
      id: "tool-1",
      toolName: "edit_file",
      summary: "+1 -1",
      status: "done",
      ts: 2,
      toolArgs,
      resultText: RESULT,
      expand: buildToolExpandView("edit_file", toolArgs, RESULT, "done") ?? undefined,
    };
    const next = upsertStreamThreadItem(cur, done);
    const tool = next.find((i) => i.kind === "tool") as Extract<StreamThreadItem, { kind: "tool" }>;
    return tool.expand as { kind: string; oldContent?: string; newContent?: string };
  }

  it("keeps the whole file when the finishing item carries the model's snippets", () => {
    seedRunningTool("README.md");
    mergeWritePreviewIntoThread(CHAT_ID, "README.md", "update", OLD, NEW);
    const expand = finish({ path: "README.md", operation: "replace", old_content: "Counts words.", new_content: "Counts the words in a text." });
    expect(expand.kind).toBe("diff");
    expect(expand.oldContent).toBe(OLD);
    expect(expand.newContent).toBe(NEW);
  });

  it("is a diff, not '1 line written', when the finishing item carries no args", () => {
    seedRunningTool("README.md");
    mergeWritePreviewIntoThread(CHAT_ID, "README.md", "update", OLD, NEW);
    const expand = finish(undefined);
    expect(expand.kind).toBe("diff");
    expect(expand.oldContent).toBe(OLD);
  });

  it("is rebuilt when the preview arrives after the card finished", () => {
    const done: StreamThreadItem = {
      kind: "tool",
      id: "tool-1",
      toolName: "edit_file",
      summary: "+1 -1",
      status: "done",
      ts: 1,
      toolArgs: { path: "README.md", operation: "replace", old_content: "Counts words.", new_content: "Counts the words in a text." },
      resultText: RESULT,
    };
    getDefaultStore().set(streamThreadByChatIdAtom, new Map([[CHAT_ID, [done]]]));
    mergeWritePreviewIntoThread(CHAT_ID, "README.md", "update", OLD, NEW);
    const tool = getDefaultStore().get(streamThreadByChatIdAtom).get(CHAT_ID)![0] as Extract<StreamThreadItem, { kind: "tool" }>;
    expect((tool.expand as { oldContent?: string }).oldContent).toBe(OLD);
  });
});

/**
 * QA #6 on build D: an edit approved by hand still numbered the snippet 1-5
 * (lines 10-14 in the file). Its args held the whole file; its view did not:
 * the tool's END event carries a view main built from the model's args, and
 * finishing a card that way replaced it without looking at the merged file.
 */
import { completeStreamToolOnEnd } from "@/lib/chat/stream-thread";

describe("a write card finished by its end event", () => {
  it("keeps the whole-file diff, not the end event's snippet view", () => {
    const OLD = "a\nb\nexport function topWords(text, n = 3) {\n  return n;\n}\n";
    const NEW = "a\nb\nexport function topWords(text, limit = 3) {\n  return limit;\n}\n";
    const store = getDefaultStore();
    const running: StreamThreadItem = {
      kind: "tool",
      id: "call_9",
      toolName: "edit_file",
      summary: "Editing",
      status: "running",
      ts: 1,
      toolArgs: { path: "src/tally.js", operation: "replace", old_content: "export function topWords(text, n = 3) {", new_content: "export function topWords(text, limit = 3) {" },
    };
    store.set(streamThreadByChatIdAtom, new Map([[CHAT_ID, [running]]]));
    mergeWritePreviewIntoThread(CHAT_ID, "src/tally.js", "update", OLD, NEW);
    const snippetView = buildToolExpandView(
      "edit_file",
      { path: "src/tally.js", operation: "replace", old_content: "export function topWords(text, n = 3) {", new_content: "export function topWords(text, limit = 3) {" },
      JSON.stringify({ success: true, path: "src/tally.js", operation: "update", added: 2, removed: 2 }),
      "done",
    );
    const [done] = completeStreamToolOnEnd(store.get(streamThreadByChatIdAtom).get(CHAT_ID)!, {
      toolCallId: "call_9",
      toolName: "edit_file",
      status: "done",
      resultText: JSON.stringify({ success: true, path: "src/tally.js", operation: "update", added: 2, removed: 2 }),
      expand: snippetView ?? undefined,
    } as never) as Array<Extract<StreamThreadItem, { kind: "tool" }>>;
    expect((done.expand as { oldContent?: string }).oldContent).toBe(OLD);
  });
});
