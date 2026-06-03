import { describe, expect, it } from "vitest";
import {
  formatStreamToolResultPreview,
  formatToolResultPreview,
  formatToolStartPreview,
  summarizeToolResultForActivityDetail,
} from "@/lib/chat/stream-tool-display";

describe("formatToolResultPreview", () => {
  it("formats explore_folder with total and item paths (no JSON dump)", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        path: ".",
        total: 120,
        items: [
          { path: "src/gchat/server.ts", type: "file" },
          { path: "src/gchat/agentLoop.ts", type: "file" },
          { path: "src/gchat/memory.ts", type: "file" },
          { path: "src/other.ts", type: "file" },
        ],
      },
    });
    const preview = formatToolResultPreview("explore_folder", raw, "done");
    expect(preview).toMatch(/120 items/);
    expect(preview).toContain("src/gchat/server.ts");
    expect(preview).not.toMatch(/\[\s*\{/);
    expect(preview).not.toContain('"type"');
  });

  it("formats search with match count and first three paths", () => {
    const raw = JSON.stringify({
      success: true,
      matches: [
        { path: "src/a.ts" },
        { path: "src/b.ts" },
        { path: "src/c.ts" },
        { path: "src/d.ts" },
      ],
    });
    const preview = formatToolResultPreview("search", raw, "done");
    expect(preview).toMatch(/4 matches found/);
    expect(preview).toContain("src/a.ts");
    expect(preview).toContain("src/b.ts");
    expect(preview).toContain("src/c.ts");
    expect(preview).not.toContain("src/d.ts");
  });

  it("formats read_file with first lines capped at 200 chars", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const raw = JSON.stringify({ success: true, result: lines });
    const preview = formatToolResultPreview("read_file", raw, "done");
    expect(preview).toContain("line 1");
    expect(preview).not.toContain("line 20");
    expect(preview!.length).toBeLessThanOrEqual(200);
  });

  it("formats write_file as lines written", () => {
    const raw = JSON.stringify({ success: true, result: "a\nb\nc" });
    expect(formatToolResultPreview("write_file", raw, "done")).toBe("3 lines written");
  });

  it("formats write_file as File saved when no countable content", () => {
    const raw = JSON.stringify({ success: true, message: "OK" });
    expect(formatToolResultPreview("write_file", raw, "done")).toBe("File saved");
  });

  it("fallback uses message field not stringified JSON", () => {
    const raw = JSON.stringify({
      success: true,
      message: "Indexed 42 symbols",
      result: { nested: true },
    });
    const preview = formatToolResultPreview("unknown_tool", raw, "done");
    expect(preview).toBe("Indexed 42 symbols");
    expect(preview).not.toContain('"nested"');
  });

  it("formatStreamToolResultPreview delegates to formatToolResultPreview", () => {
    const raw = JSON.stringify({
      success: true,
      result: { total: 2, items: [{ path: "a.ts", type: "file" }] },
    });
    expect(formatStreamToolResultPreview("explore_folder", raw, "done")).toMatch(/2 items/);
  });

  it("summarizes list_available_mcps with server and tool counts (not Done)", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        servers: [
          { name: "github", tools: [{ name: "a" }, { name: "b" }] },
          { name: "linear", tools: [{ name: "c" }] },
        ],
        usage: "Call mcp_call(...)",
      },
    });
    const preview = formatToolResultPreview("list_available_mcps", raw, "done");
    expect(preview).toBe("2 MCP servers · 3 tools");
    expect(preview).not.toBe("Done");
  });

  it("summarizes empty list_available_mcps with the friendly message", () => {
    const raw = JSON.stringify({
      success: true,
      result: { servers: [], message: "No MCP servers configured." },
    });
    expect(formatToolResultPreview("list_available_mcps", raw, "done")).toBe(
      "No MCP servers configured.",
    );
  });

  it("summarizes mcp_call as server/tool", () => {
    const raw = JSON.stringify({
      success: true,
      result: { server: "github", tool: "search_issues", result: "{}" },
    });
    expect(formatToolResultPreview("mcp_call", raw, "done")).toBe(
      "github/search_issues",
    );
  });

  it("summarizes web_search as result count", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        text: "…",
        sources: [
          { title: "a", url: "https://a.com" },
          { title: "b", url: "https://b.com" },
          { title: "c", url: "https://c.com" },
        ],
      },
    });
    expect(formatToolResultPreview("web_search", raw, "done")).toBe("3 results");
  });

  it("only falls back to Done when there is no usable payload", () => {
    const raw = JSON.stringify({ success: true, result: { ok: true } });
    expect(formatToolResultPreview("unknown_tool", raw, "done")).toBe("Done");
  });
});

describe("formatToolStartPreview", () => {
  it("includes path in running preview", () => {
    const preview = formatToolStartPreview("explore_folder", {
      path: "spacinsider-api",
    });
    expect(preview).toContain("spacinsider-api");
    expect(preview).toMatch(/…$/);
  });
});

describe("summarizeToolResultForActivityDetail", () => {
  it("uses shared formatter and caps at 500", () => {
    const result = JSON.stringify({
      success: true,
      result: {
        total: 3,
        items: [{ path: "x.ts", type: "file" }],
      },
    });
    const detail = summarizeToolResultForActivityDetail("explore_folder", result, "done");
    expect(detail).toMatch(/3 items/);
    expect(detail!.length).toBeLessThanOrEqual(500);
  });
});
