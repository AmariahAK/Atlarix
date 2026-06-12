import { describe, expect, it } from "vitest";
import {
  groupPaginatableRuns,
  isPaginatableToolName,
  TOOL_PAGE_SIZE,
} from "@/lib/chat/paginate-tool-runs";

type Item = { tool: string | null };
const tool = (t: string | null): Item => ({ tool: t });
const nameOf = (i: Item) => i.tool;

describe("paginate-tool-runs", () => {
  it("recognizes paginatable tools", () => {
    expect(isPaginatableToolName("run_command")).toBe(true);
    expect(isPaginatableToolName("write_file")).toBe(true);
    expect(isPaginatableToolName("edit_file")).toBe(true);
    expect(isPaginatableToolName("read_file")).toBe(false);
    expect(isPaginatableToolName(null)).toBe(false);
  });

  it("bundles a long consecutive run of command/file cards into one run", () => {
    const items = Array.from({ length: TOOL_PAGE_SIZE + 4 }, () =>
      tool("run_command"),
    );
    const groups = groupPaginatableRuns(items, nameOf);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("run");
    expect((groups[0] as { items: Item[] }).items).toHaveLength(TOOL_PAGE_SIZE + 4);
  });

  it("leaves short runs (<= page size) as singles", () => {
    const items = Array.from({ length: TOOL_PAGE_SIZE }, () => tool("write_file"));
    const groups = groupPaginatableRuns(items, nameOf);
    expect(groups).toHaveLength(TOOL_PAGE_SIZE);
    expect(groups.every((g) => g.type === "single")).toBe(true);
  });

  it("preserves order and only bundles consecutive paginatable cards", () => {
    // text, 8x run_command, thought, 2x read_file
    const items: Item[] = [
      tool(null),
      ...Array.from({ length: 8 }, () => tool("edit_file")),
      tool(null),
      tool("read_file"),
      tool("read_file"),
    ];
    const groups = groupPaginatableRuns(items, nameOf);
    // single(text) | run(8 edits) | single(thought) | single(read) | single(read)
    expect(groups.map((g) => g.type)).toEqual([
      "single",
      "run",
      "single",
      "single",
      "single",
    ]);
    expect((groups[1] as { items: Item[] }).items).toHaveLength(8);
  });

  it("mixed consecutive command+file cards bundle together", () => {
    const items = [
      tool("run_command"),
      tool("write_file"),
      tool("run_command"),
      tool("edit_file"),
      tool("run_command"),
      tool("write_file"),
      tool("run_command"),
    ];
    const groups = groupPaginatableRuns(items, nameOf);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("run");
  });
});
