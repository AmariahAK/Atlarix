import { describe, expect, it } from "vitest";
import {
  buildToolExpandView,
  parseGrepDisplayText,
  splitPathForDisplay,
} from "@/lib/chat/tool-expand-view";

describe("splitPathForDisplay", () => {
  it("splits path into name and directory", () => {
    expect(splitPathForDisplay("Atlarix/src/foo.ts")).toEqual({
      fileName: "foo.ts",
      directory: "./Atlarix/src",
    });
  });
});

describe("parseGrepDisplayText", () => {
  it("parses file blocks and match counts", () => {
    const text = `Found 3 match(es) for "foo" across 2 file(s):

📄 src/a.ts
  10: const foo = 1
  20: foo bar

📄 src/b.ts
  5: foo
`;
    const files = parseGrepDisplayText(text);
    expect(files).toHaveLength(2);
    expect(files[0]!.matchCount).toBe(2);
    expect(files[1]!.matchCount).toBe(1);
  });
});

describe("buildToolExpandView", () => {
  it("formats explore_folder as file_list", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        total: 2,
        items: [
          { path: "src/a.ts", type: "file" },
          { path: "src/b.ts", type: "file" },
        ],
      },
    });
    const view = buildToolExpandView("explore_folder", { path: "." }, raw, "done");
    expect(view.kind).toBe("file_list");
    if (view.kind === "file_list") {
      expect(view.total).toBe(2);
      expect(view.entries[0]!.fileName).toBe("a.ts");
    }
  });

  it("formats search ui.groups as match_list", () => {
    const raw = JSON.stringify({
      success: true,
      result: "Found 2 matches…",
      ui: {
        groups: [
          { file: "src/a.ts", matchCount: 2 },
          { file: "src/b.ts", matchCount: 1 },
        ],
      },
    });
    const view = buildToolExpandView("search_code", { query: "x" }, raw, "done");
    expect(view.kind).toBe("match_list");
    if (view.kind === "match_list") {
      expect(view.totalMatches).toBe(3);
      expect(view.files[0]!.matchCount).toBe(2);
    }
  });

  it("formats write_file with old and new content as diff", () => {
    const raw = JSON.stringify({
      success: true,
      path: "src/x.ts",
      oldContent: "a\n",
      newContent: "a\nb\n",
      operation: "update",
    });
    const view = buildToolExpandView("write_file", { path: "src/x.ts" }, raw, "done");
    expect(view.kind).toBe("diff");
    if (view.kind === "diff") {
      expect(view.fileName).toBe("x.ts");
      expect(view.newContent).toContain("b");
    }
  });

  it("uses text fallback for errors without JSON dump", () => {
    const raw = JSON.stringify({ success: false, error: "Permission denied" });
    const view = buildToolExpandView("read_file", {}, raw, "error");
    expect(view.kind).toBe("text");
    if (view.kind === "text") {
      expect(view.body).toContain("Permission denied");
      expect(view.body).not.toContain('"success"');
    }
  });

  it("formats web_search sources as search_results with links", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        text: "…",
        sources: [
          { title: "React Hooks", url: "https://react.dev/hooks", content: "intro" },
          { title: "MDN", url: "https://developer.mozilla.org" },
        ],
      },
    });
    const view = buildToolExpandView(
      "web_search",
      { query: "react hooks" },
      raw,
      "done",
    );
    expect(view.kind).toBe("search_results");
    if (view.kind === "search_results") {
      expect(view.query).toBe("react hooks");
      expect(view.results).toHaveLength(2);
      expect(view.results[0]!.url).toBe("https://react.dev/hooks");
    }
  });

  it("formats list_available_mcps as mcp_servers", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        servers: [
          {
            id: 1,
            name: "github",
            transport: "stdio",
            scope: "global",
            tools: [
              { name: "search_issues", description: "Search issues" },
              { name: "create_pr" },
            ],
          },
        ],
        usage: "Call mcp_call(...) to invoke a tool.",
      },
    });
    const view = buildToolExpandView("list_available_mcps", {}, raw, "done");
    expect(view.kind).toBe("mcp_servers");
    if (view.kind === "mcp_servers") {
      expect(view.servers).toHaveLength(1);
      expect(view.servers[0]!.name).toBe("github");
      expect(view.servers[0]!.tools).toHaveLength(2);
      expect(view.usage).toContain("mcp_call");
    }
  });

  it("renders empty list_available_mcps with a friendly message", () => {
    const raw = JSON.stringify({
      success: true,
      result: { servers: [], message: "No MCP servers configured." },
    });
    const view = buildToolExpandView("list_available_mcps", {}, raw, "done");
    expect(view.kind).toBe("mcp_servers");
    if (view.kind === "mcp_servers") {
      expect(view.servers).toHaveLength(0);
      expect(view.message).toContain("No MCP servers configured");
    }
  });

  it("surfaces list_available_mcps error as error text", () => {
    const raw = JSON.stringify({
      success: true,
      result: { error: "MCP manager unavailable" },
    });
    const view = buildToolExpandView("list_available_mcps", {}, raw, "done");
    expect(view.kind).toBe("text");
    if (view.kind === "text") {
      expect(view.isError).toBe(true);
      expect(view.body).toContain("MCP manager unavailable");
    }
  });

  it("formats mcp_call success as mcp_result", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        server: "github",
        tool: "search_issues",
        result: JSON.stringify({ items: [{ id: 1 }] }),
      },
    });
    const view = buildToolExpandView("mcp_call", {}, raw, "done");
    expect(view.kind).toBe("mcp_result");
    if (view.kind === "mcp_result") {
      expect(view.server).toBe("github");
      expect(view.tool).toBe("search_issues");
      // JSON string result is pretty-printed
      expect(view.body).toContain("items");
      expect(view.body).toContain("\n");
    }
  });

  it("surfaces mcp_call error as error text", () => {
    const raw = JSON.stringify({
      success: true,
      result: { error: "User declined running MCP tool github/search_issues." },
    });
    const view = buildToolExpandView("mcp_call", {}, raw, "done");
    expect(view.kind).toBe("text");
    if (view.kind === "text") {
      expect(view.isError).toBe(true);
      expect(view.body).toContain("declined");
    }
  });

  it("renders mcp_call needs-auth as an mcp_auth view (oauth)", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        error: 'MCP server "spacinsider" requires sign-in.',
        needsOAuth: true,
        authRequired: {
          serverId: 7,
          serverName: "spacinsider",
          authType: "oauth",
          reason: "missing",
        },
      },
    });
    const view = buildToolExpandView("mcp_call", {}, raw, "done");
    expect(view.kind).toBe("mcp_auth");
    if (view.kind === "mcp_auth") {
      expect(view.serverId).toBe(7);
      expect(view.serverName).toBe("spacinsider");
      expect(view.authType).toBe("oauth");
    }
  });

  it("renders mcp_call needs-auth as an mcp_auth view (api_key)", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        error: 'MCP server "linear" is not authenticated.',
        authRequired: {
          serverId: 9,
          serverName: "linear",
          authType: "api_key",
          reason: "invalid",
        },
      },
    });
    const view = buildToolExpandView("mcp_call", {}, raw, "done");
    expect(view.kind).toBe("mcp_auth");
    if (view.kind === "mcp_auth") {
      expect(view.authType).toBe("api_key");
      expect(view.reason).toBe("invalid");
    }
  });
});
