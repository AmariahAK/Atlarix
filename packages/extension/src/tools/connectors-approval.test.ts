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

/** The account's connectors as /mcp/list returns them. */
const LIST = {
  ok: true,
  servers: [{ name: "Linear", tools: [{ name: "create_issue" }, { name: "list_issues" }] }],
};
const calls = () => proxy.mock.calls.filter((c) => c[0] === "/mcp/call");

describe("mcp_call asks first", () => {
  it("asks, and calls nothing, on the first dispatch", async () => {
    proxy.mockResolvedValueOnce(LIST);
    const out = await mcpCall(args);
    expect(out.needsApproval).toEqual({
      kind: "action",
      reason: "Atlarix wants to use your Linear connector.",
      category: "connector",
      summary: "Run create_issue on Linear?",
    });
    expect(calls()).toHaveLength(0);
  });

  // QA 15.7.1 #16: the model guessed "ask_deepwiki", the user approved, and the
  // call failed with "Unknown tool". A yes is only asked for a call that can run.
  it("doesn't ask for a tool the connector doesn't have", async () => {
    proxy.mockResolvedValueOnce(LIST);
    const out = await mcpCall({ server: "linear", tool: "make_issue" });
    expect(out.needsApproval).toBeUndefined();
    expect(out.content).toContain("Linear has no tool make_issue");
    expect(out.content).toContain("create_issue, list_issues");
    expect(calls()).toHaveLength(0);
  });

  it("still asks when the list can't tell (unreadable, or a name it doesn't show)", async () => {
    proxy.mockRejectedValueOnce(new Error("down"));
    expect((await mcpCall(args)).needsApproval).toBeDefined();
    proxy.mockResolvedValueOnce(LIST);
    expect((await mcpCall({ server: "linear-slug", tool: "x" })).needsApproval).toBeDefined();
    expect(calls()).toHaveLength(0);
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
