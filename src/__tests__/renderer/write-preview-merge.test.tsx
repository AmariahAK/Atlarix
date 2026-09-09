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
