/**
 * `subagents` — managing running sub-agents, and auto-promotion.
 *
 * The promotion test is the important one. Before v14.21.0 a FOREGROUND
 * `task()` had no timeout of any kind (the 10-minute one applied only to
 * `background: true`), so a slow sub-agent blocked the turn indefinitely with
 * no signal — which is what "the sub-agent looks stuck" actually was.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/run-subagent", () => ({
  runSubagent: vi.fn(),
}));

async function tools() {
  await import("@/lib/tools/index");
  const { ToolRegistry } = await import("@/lib/tools/registry");
  return ToolRegistry;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("addressing a sub-agent by name", () => {
  it("resolves by the name given to task({description}), not just the id", async () => {
    const ToolRegistry = await tools();
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const chatId = 9200;

    vi.mocked(runSubagent).mockImplementation(
      (a: Parameters<typeof runSubagent>[0]) =>
        new Promise((_res, rej) => {
          a.emit?.({
            type: "subagent_thought",
            id: "s1",
            channel: "text",
            content: "reading the router",
          });
          a.abortSignal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );

    const task = ToolRegistry.get("task");
    await task!.handler({
      description: "map the router",
      prompt: "Map it",
      background: true,
      chatId,
    });
    await new Promise((r) => setTimeout(r, 10));

    const byName = (await ToolRegistry.execute("subagents", {
      operation: "output",
      agent: "router", // a substring of the name — no id anywhere
      _chatSessionId: chatId,
    })) as { result?: { output?: string; running?: boolean } };
    expect(byName.result?.running).toBe(true);
    expect(byName.result?.output).toContain("reading the router");

    await ToolRegistry.execute("subagents", {
      operation: "cancel",
      agent: "router",
      _chatSessionId: chatId,
    });
    const { clearSubagentsForChat } = await import("@/lib/agents/subagent-results");
    clearSubagentsForChat(chatId);
  });

  it("lists the candidates instead of failing blind on an ambiguous name", async () => {
    const ToolRegistry = await tools();
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const chatId = 9201;

    vi.mocked(runSubagent).mockImplementation(
      (a: Parameters<typeof runSubagent>[0]) =>
        new Promise((_res, rej) => {
          a.abortSignal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );

    const task = ToolRegistry.get("task");
    for (const d of ["scan auth routes", "scan auth models"]) {
      await task!.handler({ description: d, prompt: "x", background: true, chatId });
    }

    const out = (await ToolRegistry.execute("subagents", {
      operation: "output",
      agent: "scan auth",
      _chatSessionId: chatId,
    })) as { error?: string };
    expect(out.error).toContain("matches 2 sub-agents");
    expect(out.error).toContain("scan auth routes");
    expect(out.error).toContain("scan auth models");

    for (const d of ["scan auth routes", "scan auth models"]) {
      await ToolRegistry.execute("subagents", {
        operation: "cancel",
        agent: d,
        _chatSessionId: chatId,
      });
    }
    const { clearSubagentsForChat } = await import("@/lib/agents/subagent-results");
    clearSubagentsForChat(chatId);
  });

  it("tail does not consume the incremental cursor", async () => {
    const ToolRegistry = await tools();
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const chatId = 9202;

    let emit: Parameters<typeof runSubagent>[0]["emit"];
    vi.mocked(runSubagent).mockImplementation(
      (a: Parameters<typeof runSubagent>[0]) =>
        new Promise((_res, rej) => {
          emit = a.emit;
          a.abortSignal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );

    const task = ToolRegistry.get("task");
    await task!.handler({
      description: "cursor test",
      prompt: "x",
      background: true,
      chatId,
    });
    await new Promise((r) => setTimeout(r, 10));

    emit?.({ type: "subagent_thought", id: "a", channel: "text", content: "FIRST" });
    const read = (o: Record<string, unknown>) =>
      ToolRegistry.execute("subagents", {
        operation: "output",
        agent: "cursor test",
        _chatSessionId: chatId,
        ...o,
      }) as Promise<{ result?: { output?: string } }>;

    expect((await read({})).result?.output).toContain("FIRST");
    // Consumed — nothing new.
    expect((await read({})).result?.output).toContain("nothing new");
    // tail still shows it, and must NOT move the cursor...
    expect((await read({ mode: "tail" })).result?.output).toContain("FIRST");
    emit?.({ type: "subagent_thought", id: "b", channel: "text", content: "SECOND" });
    // ...so the next incremental read sees only what actually arrived after.
    const next = (await read({})).result?.output ?? "";
    expect(next).toContain("SECOND");
    expect(next).not.toContain("FIRST");

    await ToolRegistry.execute("subagents", {
      operation: "cancel",
      agent: "cursor test",
      _chatSessionId: chatId,
    });
    const { clearSubagentsForChat } = await import("@/lib/agents/subagent-results");
    clearSubagentsForChat(chatId);
  });
});

describe("auto-promotion", () => {
  it("moves a slow FOREGROUND sub-agent to the background instead of blocking", async () => {
    const ToolRegistry = await tools();
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const chatId = 9203;

    let release: (() => void) | undefined;
    vi.mocked(runSubagent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ success: true, summary: "took its time", stepsUsed: 1 });
        }),
    );

    vi.useFakeTimers();
    const task = ToolRegistry.get("task");
    // NOTE: no background:true — this is the foreground path.
    const pending = task!.handler({
      description: "slow scout",
      prompt: "Take a while",
      chatId,
    });
    await vi.advanceTimersByTimeAsync(31_000);
    const out = String(await pending);

    expect(out).toContain('state="running"');
    expect(out).toContain("moved to the background");
    expect(out).toContain('subagents({operation:"output"');

    // And it is genuinely still alive: releasing it delivers the result.
    release?.();
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));

    const store = await import("@/lib/agents/subagent-results");
    expect(store.hasPendingSubagentResults(chatId)).toBe(true);
    expect(store.takePendingSubagentResults(chatId)).toContain("took its time");
    store.clearSubagentsForChat(chatId);
  });

  it("returns inline when the sub-agent finishes before the threshold", async () => {
    const ToolRegistry = await tools();
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    vi.mocked(runSubagent).mockImplementationOnce(async () => ({
      success: true,
      summary: "quick answer",
      stepsUsed: 1,
    }));

    const out = String(
      await ToolRegistry.get("task")!.handler({
        description: "quick scout",
        prompt: "Answer fast",
        chatId: 9204,
      }),
    );
    expect(out).toContain('state="completed"');
    expect(out).toContain("quick answer");
    expect(out).not.toContain("moved to the background");
  });
});

describe("task no longer manages sub-agents", () => {
  it("redirects list/cancel to the subagents tool rather than dead-ending", async () => {
    const ToolRegistry = await tools();
    const out = String(
      await ToolRegistry.get("task")!.handler({ list: true, chatId: 9205 }),
    );
    expect(out).toContain("subagents");
    expect(out).toContain('operation:"list"');
  });
});

describe("mode availability", () => {
  it("is callable in Plan mode, where background_jobs is not", async () => {
    const { isToolAllowedInMode } = await import("@/lib/tools/mode-tool-registry");
    // Plan can't run commands, so it has no business managing background
    // commands — but it delegates read-only sub-agents, so it must manage those.
    expect(isToolAllowedInMode("subagents", "plan")).toBe(true);
    expect(isToolAllowedInMode("background_jobs", "plan")).toBe(false);
    for (const mode of ["ask", "build", "debug", "review"] as const) {
      expect(isToolAllowedInMode("subagents", mode)).toBe(true);
    }
  });
});
