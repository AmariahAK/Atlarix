/**
 * Every request leaves with its tool calls and results paired (HANDOFF
 * 2026-10-31 item 1c). A tool result whose call is gone, or a call with no
 * result, is a 400 from every provider ("Messages with role 'tool' must be a
 * response to a preceding message with 'tool_calls'"), and every later request
 * in that chat fails the same way. The check runs before each step is sent
 * (simple-stream-text prepareStep): a paired history passes untouched (the same
 * array, so the prompt cache holds); a broken one is repaired, not sent.
 *
 * And the second cut site, the budget backstop's drop (tier_context_budget.ts),
 * never starts its kept tail on a tool result and never drops a call while
 * keeping its result, as c3e7acd2 made the mid-round compaction cut do.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
const budget = vi.hoisted(() => ({ tierLimit: 10_000 }));
vi.mock("@/lib/context/resolve-model-context-limit", () => ({
  resolveModelContextLimit: async () => ({ tierLimit: budget.tierLimit, rawContextLength: budget.tierLimit }),
}));

const { pairToolMessages } = await import("@/lib/ai/tool-pairing");
const { enforceContextBudget, estimateDispatchTokens } = await import("@/lib/routing/tier_context_budget");

const call = (id: string, extra: Record<string, unknown> = {}) => ({ type: "tool-call", toolCallId: id, toolName: "grep", input: {}, ...extra });
const result = (id: string) => ({ type: "tool-result", toolCallId: id, toolName: "grep", output: { type: "text", value: "ok" } });
const assistant = (...content: unknown[]) => ({ role: "assistant", content }) as unknown as ModelMessage;
const tool = (...content: unknown[]) => ({ role: "tool", content }) as unknown as ModelMessage;
const user = (text: string) => ({ role: "user", content: text }) as ModelMessage;
const system = { role: "system", content: "SYS" } as ModelMessage;

/** What every provider checks: each result answers a call in the assistant message just before. */
function isPaired(messages: ModelMessage[]): boolean {
  let open: Set<string> | null = null;
  const answered = new Set<string>();
  for (const m of messages) {
    const parts = Array.isArray(m.content) ? (m.content as Array<{ type: string; toolCallId?: string; providerExecuted?: boolean }>) : [];
    if (m.role === "tool") {
      for (const p of parts) if (p.type === "tool-result" && !open?.has(p.toolCallId!)) return false;
      for (const p of parts) if (p.type === "tool-result") answered.add(p.toolCallId!);
      continue;
    }
    if (open && [...open].some((id) => !answered.has(id))) return false;
    open = null;
    answered.clear();
    const calls = parts.filter((p) => p.type === "tool-call" && !p.providerExecuted).map((p) => p.toolCallId!);
    if (m.role === "assistant" && calls.length) open = new Set(calls);
  }
  return !(open && [...open].some((id) => !answered.has(id)));
}

describe("pairToolMessages", () => {
  it("passes a paired history untouched, as the same array", () => {
    const messages = [system, user("go"), assistant(call("a"), call("b")), tool(result("a")), tool(result("b")), assistant({ type: "text", text: "done" })];
    const out = pairToolMessages(messages);
    expect(out.messages).toBe(messages);
    expect(out.repaired).toBe(false);
  });

  it("drops a tool result whose call was cut away (the kept tail opened on it)", () => {
    const messages = [system, user("[summary]"), tool(result("gone")), assistant(call("a")), tool(result("a")), user("next")];
    const out = pairToolMessages(messages);
    expect(out.repaired).toBe(true);
    expect(isPaired(out.messages)).toBe(true);
    expect(JSON.stringify(out.messages)).not.toContain("gone");
    expect(JSON.stringify(out.messages)).toContain('"toolCallId":"a"');
  });

  it("drops a call that has no result anywhere", () => {
    const messages = [user("go"), assistant({ type: "text", text: "looking" }, call("lost")), user("hello?")];
    const out = pairToolMessages(messages);
    expect(isPaired(out.messages)).toBe(true);
    expect(JSON.stringify(out.messages)).not.toContain("lost");
    // The assistant's words stay.
    expect(JSON.stringify(out.messages)).toContain("looking");
  });

  it("removes a message the repair leaves empty", () => {
    const out = pairToolMessages([user("go"), assistant(call("lost")), user("again")]);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("rejoins a result that a message landed between, instead of losing it", () => {
    const messages = [user("go"), assistant(call("a")), user("[injected note]"), tool(result("a")), assistant({ type: "text", text: "done" })];
    const out = pairToolMessages(messages);
    expect(isPaired(out.messages)).toBe(true);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
  });

  it("leaves provider-run tools (their result rides in the assistant message) alone", () => {
    const messages = [user("go"), assistant(call("ws", { providerExecuted: true }), { ...result("ws"), providerExecuted: true }, { type: "text", text: "found" })];
    expect(pairToolMessages(messages).messages).toBe(messages);
  });
});

describe("the budget backstop's drop (the second cut site)", () => {
  const big = "x".repeat(4_000);
  const history = () => [
    { role: "system", content: "SYS" },
    { role: "user", content: big },
    { role: "assistant", content: big },
    { role: "user", content: big },
    { role: "assistant", content: big },
    { role: "tool", content: big },
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
    { role: "assistant", content: "d" },
    { role: "user", content: "e" },
  ];

  const enforce = async (h: Array<{ role: string; content: string }>, tierLimit: number) => {
    budget.tierLimit = tierLimit;
    return enforceContextBudget({
      settings: {} as never,
      effectiveModel: { provider: "test", name: "m" } as never,
      userPrompt: "go",
      systemPrompt: "SYS",
      contextAssemblerBlob: "",
      limitedMessageHistory: h,
      codebasePrefixMessages: [],
      otherCodebasePrefixMessages: [],
      toolSurfaceTokens: 0,
    });
  };

  it("keeps a kept call's result with it, and never opens the kept part on a result", async () => {
    const h = history();
    // Over by a little: one drop of two messages is enough.
    const limit =
      estimateDispatchTokens({ systemPrompt: "SYS", history: h, codebasePrefixMessages: [], otherCodebasePrefixMessages: [], toolSurfaceTokens: 0 }) - 10;
    const out = await enforce(h, limit);
    const roles = out.limitedMessageHistory.map((m) => m.role);
    // It used to keep the assistant row and silently drop its result.
    expect(roles).toEqual(["system", "user", "assistant", "tool", "user", "assistant", "user", "assistant", "user"]);
    expect(roles.filter((r) => r !== "system")[0]).not.toBe("tool");
    expect(out.droppedMessageCount).toBe(2);
  });

  it("drops the two oldest messages and the result of a call among them", async () => {
    // The call's assistant is the second-oldest; its result goes with it.
    const h = [
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "tool", content: big },
      { role: "user", content: big },
      { role: "assistant", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
      { role: "assistant", content: "e" },
      { role: "user", content: "f" },
    ];
    const limit =
      estimateDispatchTokens({ systemPrompt: "SYS", history: h, codebasePrefixMessages: [], otherCodebasePrefixMessages: [], toolSurfaceTokens: 0 }) - 10;
    const out = await enforce(h, limit);
    expect(out.limitedMessageHistory[0]?.role).toBe("user");
    expect(out.limitedMessageHistory.some((m) => m.role === "tool")).toBe(false);
    expect(out.droppedMessageCount).toBe(3);
  });

  it("without tool rows it drops exactly as before: two at a time", async () => {
    const h = history().filter((m) => m.role !== "tool");
    const limit =
      estimateDispatchTokens({ systemPrompt: "SYS", history: h, codebasePrefixMessages: [], otherCodebasePrefixMessages: [], toolSurfaceTokens: 0 }) - 10;
    const out = await enforce(h, limit);
    expect(out.droppedMessageCount).toBe(2);
    expect(out.limitedMessageHistory.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user", "assistant", "user"]);
  });
});
