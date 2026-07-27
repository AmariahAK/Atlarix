import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/run-subagent", () => ({
  runSubagent: vi.fn(async () => ({
    success: true,
    summary: "Mapped packages/api — 3 modules, entry at index.ts",
    stepsUsed: 2,
  })),
}));

/** Registry lookup after the side-effect import that populates it. */
async function tool() {
  const { ToolRegistry } = await import("@/lib/tools/registry");
  return ToolRegistry.get("task");
}

describe("task tool", () => {
  it("registers task and returns a completed envelope from runSubagent", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const tool = ToolRegistry.get("task");
    expect(tool?.name).toBe("task");
    const out = await tool!.handler({
      description: "map api",
      prompt: "Map packages/api",
    });
    expect(String(out)).toContain('<task id="');
    expect(String(out)).toContain('state="completed"');
    expect(String(out)).toContain("Mapped packages/api");
  });

  it("background=true returns a running envelope immediately", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const tool = ToolRegistry.get("task");
    const out = await tool!.handler({
      description: "map api",
      prompt: "Map packages/api in the background",
      background: true,
    });
    expect(String(out)).toContain('state="running"');
    expect(String(out)).toContain("Background sub-agent started");
  });

  it("background task records its result into the per-chat store on completion", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const store = await import("@/lib/agents/subagent-results");
    const chatId = 7777;
    const tool = ToolRegistry.get("task");
    await tool!.handler({
      description: "map api",
      prompt: "Map packages/api in the background",
      background: true,
      chatId,
    });
    // The mocked runSubagent resolves immediately; let the async finalize run.
    await new Promise((r) => setTimeout(r, 20));
    expect(store.hasPendingSubagentResults(chatId)).toBe(true);
    const block = store.takePendingSubagentResults(chatId);
    expect(block).toContain("[Background sub-agent results]");
    expect(block).toContain("Mapped packages/api");
    expect(store.hasRunningSubagents(chatId)).toBe(false);
    store.clearSubagentsForChat(chatId);
  });

  it("unknown task_id resumes to an error envelope", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const tool = ToolRegistry.get("task");
    const out = await tool!.handler({
      description: "resume",
      prompt: "n/a",
      task_id: "nope",
    });
    expect(String(out)).toContain('state="error"');
    expect(String(out)).toContain("Unknown task_id");
  });

  it("cancelling a background sub-agent aborts it and suppresses the auto-wake", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const store = await import("@/lib/agents/subagent-results");
    const chatId = 8888;

    // Runs until its model stream is aborted — proving abortSignal is actually
    // threaded into runSubagent.
    let aborted = false;
    vi.mocked(runSubagent).mockImplementationOnce(
      (a: Parameters<typeof runSubagent>[0]) =>
        new Promise((_resolve, reject) => {
          a.abortSignal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );

    const started = String(
      await (await tool())!.handler({
        description: "long scout",
        prompt: "Map the whole repo slowly",
        background: true,
        chatId,
      }),
    );
    const taskId = started.match(/<task id="([^"]+)"/)?.[1];
    expect(taskId).toBeTruthy();

    // Listing and cancelling live on `subagents` as of v14.21.
    const listed = (await ToolRegistry.execute("subagents", {
      operation: "list",
      _chatSessionId: chatId,
    })) as { result?: { subagents?: Array<{ name: string; task_id: string }> } };
    expect(listed.result?.subagents?.[0]?.name).toBe("long scout");
    expect(listed.result?.subagents?.[0]?.task_id).toBe(taskId);

    await ToolRegistry.execute("subagents", {
      operation: "cancel",
      agent: "long scout",
      _chatSessionId: chatId,
    });
    expect(aborted).toBe(true);

    // No result is folded back (the caller already got the cancel confirmation).
    await new Promise((r) => setTimeout(r, 20));
    expect(store.hasPendingSubagentResults(chatId)).toBe(false);
    store.clearSubagentsForChat(chatId);
  });

  it("buffers a running sub-agent's live progress for task({task_id}) and subagents", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const chatId = 8889;

    // Emit some progress, then stay running until aborted.
    vi.mocked(runSubagent).mockImplementationOnce(
      (a: Parameters<typeof runSubagent>[0]) =>
        new Promise((_resolve, reject) => {
          a.emit?.({
            type: "subagent_thought",
            id: "t1",
            channel: "text",
            content: "Scanning packages/api for the entrypoint",
          });
          a.emit?.({
            type: "subagent_thought",
            id: "t1",
            channel: "reasoning",
            content: "noisy private reasoning that must NOT be buffered",
          });
          a.emit?.({
            type: "tool_use",
            id: "u1",
            toolName: "grep",
            status: "done",
            detail: "42 matches",
          });
          a.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const tool = ToolRegistry.get("task");
    const started = String(
      await tool!.handler({
        description: "scout api",
        prompt: "Map packages/api",
        background: true,
        chatId,
      }),
    );
    const taskId = started.match(/<task id="([^"]+)"/)?.[1];
    expect(taskId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));

    // Resume on a RUNNING task shows the progress tail (narration + done tool),
    // but NOT the raw reasoning.
    const peek = String(await tool!.handler({ task_id: taskId!, chatId }));
    expect(peek).toContain("task_progress");
    expect(peek).toContain("Scanning packages/api");
    expect(peek).toContain("done grep");
    expect(peek).not.toContain("noisy private reasoning");

    // `subagents` surfaces the same tail.
    const listed = (await ToolRegistry.execute("subagents", {
      operation: "list",
      _chatSessionId: chatId,
    })) as { result?: { subagents?: Array<{ last_output?: string }> } };
    expect(listed.result?.subagents?.[0]?.last_output).toContain(
      "Scanning packages/api",
    );

    const { clearSubagentsForChat } = await import("@/lib/agents/subagent-results");
    await ToolRegistry.execute("subagents", {
      operation: "cancel",
      agent: "scout api",
      _chatSessionId: chatId,
    });
    clearSubagentsForChat(chatId);
  });

  it("a new task with no description/prompt returns a guiding error", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const tool = ToolRegistry.get("task");
    const out = String(await tool!.handler({} as never));
    expect(out).toContain('state="error"');
    expect(out).toContain("requires both");
  });

  it("write=true works on a NON-git workspace and proposes files", async () => {
    // Before v14.21.0 this silently downgraded to read-only, because writer
    // isolation was a git worktree. Proposals need no git at all.
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const nonGit = await mkdtemp(nodePath.join(tmpdir(), "atlarix-ngws-"));
    try {
      await writeFile(nodePath.join(nonGit, "a.ts"), "before\n", "utf-8");
      await import("@/lib/tools/index");
      const { runSubagent } = await import("@/lib/agents/run-subagent");
      const { recordEditProposal } = await import("@/lib/agents/subagent-proposals");

      // Stand in for the sub-agent: record one edit against its proposal set,
      // exactly as run-subagent's tool funnel does.
      vi.mocked(runSubagent).mockImplementationOnce(
        async (a: { proposalSetId?: string }) => {
          recordEditProposal(a.proposalSetId, {
            __permission_required: true,
            operation: "edit_file",
            preview: {
              path: "a.ts",
              content: "after\n",
              oldContent: "before\n",
              type: "update",
            },
          });
          return { success: true, summary: "Added the helper", stepsUsed: 1 };
        },
      );

      const out = String(
        await (await tool())!.handler({
          description: "implement",
          prompt: "Add a helper",
          write: true,
          workspace: nonGit,
        }),
      );
      expect(out).toContain('state="completed"');
      expect(out).not.toContain("not a git repository");
      // The main agent gets a reviewable per-file diff, not applied changes.
      expect(out).toContain("<subagent_proposals");
      expect(out).toContain("## a.ts");
      expect(out).toContain("-before");
      expect(out).toContain("+after");
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  it("a writer that proposes nothing says so, so phantom edits aren't trusted", async () => {
    await import("@/lib/tools/index");
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    vi.mocked(runSubagent).mockImplementationOnce(async () => ({
      success: true,
      summary: "I edited three files.",
      stepsUsed: 1,
    }));
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const ws = await mkdtemp(nodePath.join(tmpdir(), "atlarix-empty-"));
    try {
      const out = String(
        await (await tool())!.handler({
          description: "implement",
          prompt: "Add a helper",
          write: true,
          workspace: ws,
        }),
      );
      expect(out).toContain("without proposing any file changes");
      expect(out).toContain("Disregard any claim of edits");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
