/**
 * 0o c: an approval receipt ("✓ You approved …") must sit under the row that
 * asked, never at the bottom of the transcript. `askingToolCell` only matched a
 * still-RUNNING tool cell, so a batch answered before anything ran — or a tool
 * that already finished — fell back to the last cell and stacked a dozen
 * receipts above the prompt. The asking cell is now captured when the request
 * arrives and reused at answer time.
 */
import { describe, expect, it } from "vitest";
import { approvalReceiptAnchor, askingToolCell } from "@/cli/agent/session";
import type { Cell } from "@/cli/agent/transcript";

const md = (id: string): Cell => ({ kind: "markdown", id, text: id });
const tool = (id: string, target: string, status: "running" | "success"): Cell => ({
  kind: "tool",
  id,
  tool: { id, verb: "Edit", target, status },
});

describe("askingToolCell", () => {
  it("returns null once the asking cell is no longer running", () => {
    const cells = [tool("a1:t:edit1", "src/a.ts", "success")];
    expect(askingToolCell(cells, { path: "src/a.ts" })).toBeNull();
  });
});

describe("approvalReceiptAnchor", () => {
  it("anchors to the captured asking cell even after it finished", () => {
    const cells = [md("a1:p0"), tool("a1:t:edit1", "src/a.ts", "success"), md("a1:p1"), md("a2:p0")];
    // Captured while running (askingCellId); now finished, so a "running" search
    // would miss it and the receipt would otherwise land at the end (a2:p0).
    expect(approvalReceiptAnchor(cells, { path: "src/a.ts" }, "a1:t:edit1")).toBe("a1:t:edit1");
  });

  it("finds a still-running tool cell when nothing was captured", () => {
    const cells = [tool("a1:t:run1", "npm test", "running")];
    expect(approvalReceiptAnchor(cells, { command: "npm test" }, undefined)).toBe("a1:t:run1");
  });

  it("falls back to the last tool cell, never the transcript end", () => {
    const cells = [md("a1:p0"), tool("a1:t:edit1", "src/a.ts", "success"), md("a1:p1"), md("a2:p0")];
    // Nothing captured and nothing running: the last tool cell, not a2:p0.
    expect(approvalReceiptAnchor(cells, { path: "src/a.ts" }, undefined)).toBe("a1:t:edit1");
  });
});
