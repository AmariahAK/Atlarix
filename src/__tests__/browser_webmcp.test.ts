import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  WebContentsView: class {},
  BrowserWindow: { getAllWindows: () => [] },
  session: { fromPartition: vi.fn(() => ({ setPermissionRequestHandler: vi.fn(), on: vi.fn() })) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import {
  isAllowedBrowserUrl,
  normalizeBrowserInput,
} from "@/ipc/utils/browser_view_manager";
import { buildToolExpandView } from "@/lib/chat/tool-expand-view";
import {
  EVERY_MODE_TOOLS,
  isToolAllowedInMode,
} from "@/lib/tools/mode-tool-registry";

describe("in-app browser (v11)", () => {
  it("allows only http(s) URLs", () => {
    expect(isAllowedBrowserUrl("https://example.com")).toBe(true);
    expect(isAllowedBrowserUrl("http://localhost:3000/page")).toBe(true);
    expect(isAllowedBrowserUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedBrowserUrl("chrome://settings")).toBe(false);
    expect(isAllowedBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedBrowserUrl("about:blank")).toBe(false);
    expect(isAllowedBrowserUrl("not a url")).toBe(false);
  });

  it("normalizes bare domains to https and rejects junk", () => {
    expect(normalizeBrowserInput("example.com")).toBe("https://example.com");
    expect(normalizeBrowserInput("docs.foo.dev/path?q=1")).toBe(
      "https://docs.foo.dev/path?q=1",
    );
    expect(normalizeBrowserInput("https://example.com/x")).toBe(
      "https://example.com/x",
    );
    expect(normalizeBrowserInput("file:///etc/passwd")).toBeNull();
    expect(normalizeBrowserInput("hello world")).toBeNull();
    expect(normalizeBrowserInput("")).toBeNull();
  });

  it("keeps WebMCP bridge tools in EVERY mode", () => {
    expect(EVERY_MODE_TOOLS).toContain("list_webmcp_tools");
    expect(EVERY_MODE_TOOLS).toContain("call_webmcp_tool");
    for (const mode of ["ask", "plan", "build", "debug", "review"] as const) {
      expect(isToolAllowedInMode("list_webmcp_tools", mode)).toBe(true);
      expect(isToolAllowedInMode("call_webmcp_tool", mode)).toBe(true);
    }
  });

  it("gates mutating browser tools to build/debug only", () => {
    for (const tool of ["browser_click", "browser_fill"]) {
      expect(isToolAllowedInMode(tool, "build")).toBe(true);
      expect(isToolAllowedInMode(tool, "debug")).toBe(true);
      expect(isToolAllowedInMode(tool, "ask")).toBe(false);
      expect(isToolAllowedInMode(tool, "plan")).toBe(false);
      expect(isToolAllowedInMode(tool, "review")).toBe(false);
    }
    for (const tool of ["browser_navigate", "browser_read_page", "browser_screenshot"]) {
      for (const mode of ["ask", "plan", "build", "debug", "review"] as const) {
        expect(isToolAllowedInMode(tool, mode)).toBe(true);
      }
    }
  });

  it("routes browser_screenshot results to the screenshot card", () => {
    const view = buildToolExpandView(
      "browser_screenshot",
      {},
      JSON.stringify({
        success: true,
        url: "https://example.com",
        title: "Example",
        mimeType: "image/png",
        data: "aGVsbG8=",
      }),
      "done" as never,
    );
    expect(view.kind).toBe("browser_screenshot");
    if (view.kind === "browser_screenshot") {
      expect(view.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
      expect(view.url).toBe("https://example.com");
    }
  });

  it("routes browser_read_page results to a text card with origin context", () => {
    const view = buildToolExpandView(
      "browser_read_page",
      {},
      JSON.stringify({
        success: true,
        url: "https://example.com/docs",
        title: "Docs",
        content: "[UNTRUSTED WEB CONTENT from https://example.com — …]\nHello\n[END UNTRUSTED WEB CONTENT]",
      }),
      "done" as never,
    );
    expect(view.kind).toBe("text");
    if (view.kind === "text") {
      expect(view.body).toContain("https://example.com/docs");
      expect(view.body).toContain("Hello");
    }
  });

  it("routes list_webmcp_tools results to the servers card keyed by origin", () => {
    const view = buildToolExpandView(
      "list_webmcp_tools",
      {},
      JSON.stringify({
        origin: "https://shop.example",
        tools: [
          { name: "add_to_cart", description: "Add an item to the cart" },
          { name: "search_products", description: "Search the catalog" },
        ],
        usage: "Call call_webmcp_tool(...)",
      }),
      "done" as never,
    );
    expect(view.kind).toBe("mcp_servers");
    if (view.kind === "mcp_servers") {
      expect(view.servers[0]?.name).toBe("https://shop.example");
      expect(view.servers[0]?.transport).toBe("webmcp");
      expect(view.servers[0]?.tools.map((t) => t.name)).toEqual([
        "add_to_cart",
        "search_products",
      ]);
    }
  });

  it("routes call_webmcp_tool results to the result card", () => {
    const view = buildToolExpandView(
      "call_webmcp_tool",
      { name: "add_to_cart" },
      JSON.stringify({
        success: true,
        origin: "https://shop.example",
        tool: "add_to_cart",
        result: "[UNTRUSTED WEB CONTENT from https://shop.example — …]\n{\"ok\":true}\n[END UNTRUSTED WEB CONTENT]",
      }),
      "done" as never,
    );
    expect(view.kind).toBe("mcp_result");
    if (view.kind === "mcp_result") {
      expect(view.server).toBe("https://shop.example");
      expect(view.tool).toBe("add_to_cart");
      expect(view.body).toContain('{"ok":true}');
    }
  });
});
