/**
 * A connector call is asked every time: the extension reads pages anyone can
 * write, and a connector acts as the user on another service. Nothing reaches
 * the proxy until the user says yes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const proxy = vi.fn();
vi.mock("../core/client", () => ({
  CoreError: class CoreError extends Error {},
  coreProxyFetch: (...a: unknown[]) => proxy(...a),
}));

const { mcpCall } = await import("./connectors");

const args = {
  server: "Linear",
  tool: "create_issue",
  arguments: { title: "x" },
};

beforeEach(() => {
  proxy.mockReset();
  proxy.mockResolvedValue({
    ok: true,
    server: "Linear",
    result: "<untrusted-data>done</untrusted-data>",
  });
});

describe("mcp_call asks first", () => {
  it("asks, and sends nothing, on the first dispatch", async () => {
    const out = await mcpCall(args);
    expect(out.needsApproval).toEqual({
      kind: "action",
      reason: "Atlarix wants to use your Linear connector.",
      category: "connector",
      summary: "Run create_issue on Linear?",
    });
    expect(proxy).not.toHaveBeenCalled();
  });

  it("makes the call once the user approved it", async () => {
    const out = await mcpCall(args, { approvedRetry: true });
    expect(out.needsApproval).toBeUndefined();
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy).toHaveBeenCalledWith("/mcp/call", {
      server: "Linear",
      tool: "create_issue",
      arguments: { title: "x" },
    });
    expect(out.content).toContain("<untrusted-data>done</untrusted-data>");
  });

  it("still refuses a call without server and tool, without asking", async () => {
    const out = await mcpCall({ server: "Linear" });
    expect(out.needsApproval).toBeUndefined();
    expect(proxy).not.toHaveBeenCalled();
  });
});

describe("the connector list shows each tool's argument names", () => {
  it("so the first approved call uses the right ones", async () => {
    const { listAvailableMcps } = await import("./connectors");
    proxy.mockResolvedValueOnce({
      ok: true,
      servers: [
        {
          name: "deepwiki",
          tools: [
            {
              name: "ask_question",
              description: "Ask about a repo.",
              args: [{ name: "repoName", required: true }, { name: "depth" }],
            },
            { name: "ping" },
          ],
        },
      ],
    });
    const out = await listAvailableMcps();
    expect(out.content).toContain(
      "    ask_question(repoName*, depth) — Ask about a repo.",
    );
    expect(out.content).toContain("    ping\n".trimEnd());
    expect(out.content).toContain("* = required");
  });
});
