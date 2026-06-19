import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v12 2.2 / 7B — the permission ruleset + blocking file hooks at the single
 * tool-execution funnel (runToolExecute). These cover ask+build, native AND
 * text-tool paths uniformly. A deny rule / a non-zero pre_tool_use hook
 * returns a structured tool error the model sees; a stop hook blocks
 * <task_complete>. No rules/hooks files ⇒ behavior identical to pre-2.2
 * (the existing edit-with-approval evals are that regression guard).
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/info.ts": "export const info = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("permission ruleset + file hooks (2.2/7B)", () => {
  it("a deny glob blocks a native run_command and the model sees the error", async () => {
    ctx.ws.write(
      ".atlarix/permissions.json",
      JSON.stringify({ deny: ["run_command(rm *)"] }),
    );
    ctx.server.register(
      scenario("ruleset-deny")
        .toolCall("run_command", {
          command: "rm -rf build",
          description: "clean",
        })
        .text("Understood, blocked. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=ruleset-deny Clean the build dir.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // No approval prompt should have appeared — the deny short-circuits
    // before the permission interceptor.
    expect(fakeIpc.sentOn("permission-request").length).toBe(0);

    // The structured denial reached the model in the next request.
    const requests = ctx.server.requestsFor("ruleset-deny") as Array<{
      messages: Array<{ role: string; content?: unknown }>;
    }>;
    const blob = JSON.stringify(requests);
    expect(blob).toContain("Blocked by permission rule");

    ctx.ws.write(".atlarix/permissions.json", JSON.stringify({ deny: [] }));
  }, 30_000);

  it("a global ~/.atlarix deny rule merges beneath the workspace ruleset", async () => {
    // Global layer (S16): a deny in ~/.atlarix/permissions.json blocks even
    // when the workspace file has no deny for the tool (union semantics).
    const { setGlobalAtlarixDirForTests } = await import(
      "@/lib/tools/permissions/ruleset"
    );
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const globalHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlarix-global-"),
    );
    fs.mkdirSync(path.join(globalHome, ".atlarix"), { recursive: true });
    fs.writeFileSync(
      path.join(globalHome, ".atlarix", "permissions.json"),
      JSON.stringify({ deny: ["run_command(curl *)"] }),
    );
    setGlobalAtlarixDirForTests(globalHome);
    try {
      // Workspace file exists but has only an unrelated ask rule.
      ctx.ws.write(
        ".atlarix/permissions.json",
        JSON.stringify({ ask: ["run_command(git push*)"] }),
      );
      ctx.server.register(
        scenario("global-ruleset-deny")
          .toolCall("run_command", {
            command: "curl https://example.com",
            description: "fetch",
          })
          .text("Understood, blocked. <task_complete>")
          .build(),
      );

      const chatId = await ctx.newChat();
      const { fakeIpc } = await runTurn(ctx, {
        chatId,
        prompt: "sc=global-ruleset-deny Fetch the page.",
        mode: "build",
      });
      expectNoStreamError(fakeIpc.sends, chatId);
      expectStreamEnded(fakeIpc.sends, chatId);

      // Denied at the funnel — no approval prompt, structured error to the model.
      expect(fakeIpc.sentOn("permission-request").length).toBe(0);
      const blob = JSON.stringify(ctx.server.requestsFor("global-ruleset-deny"));
      expect(blob).toContain("Blocked by permission rule");
      expect(blob).toContain("run_command(curl *)");
    } finally {
      setGlobalAtlarixDirForTests(null);
      ctx.ws.write(".atlarix/permissions.json", JSON.stringify({ deny: [] }));
    }
  }, 30_000);

  it("a non-zero pre_tool_use hook denies the tool with its stderr tail", async () => {
    ctx.ws.write(
      ".atlarix/hooks/hooks.json",
      JSON.stringify({
        hooks: [
          {
            trigger: "pre_tool_use",
            match: "run_command",
            command: "echo 'policy: no shell in this workspace' 1>&2; exit 1",
            blocking: true,
          },
        ],
      }),
    );
    ctx.server.register(
      scenario("hook-deny")
        .toolCall("run_command", { command: "ls", description: "list" })
        .text("Blocked by hook. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=hook-deny List files.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("hook-deny"));
    expect(blob).toContain("Blocked by a workspace pre_tool_use hook");
    expect(blob).toContain("no shell in this workspace");

    ctx.ws.write(".atlarix/hooks/hooks.json", JSON.stringify({ hooks: [] }));
  }, 30_000);

  it("a stop hook blocks <task_complete> until it passes", async () => {
    // The stop hook fails the first time (a sentinel file is absent) and
    // passes once it exists — the model "fixes" by creating it.
    ctx.ws.write(
      ".atlarix/hooks/hooks.json",
      JSON.stringify({
        hooks: [
          {
            trigger: "stop",
            command: "test -f .ready || (echo 'tests not green' 1>&2; exit 1)",
          },
        ],
      }),
    );
    ctx.server.register(
      scenario("hook-stop")
        // Round 1: claim done with no writes → stop hook is red → blocked.
        .text("All done. <task_complete>")
        // Round 2 (exists only because the gate blocked): create the sentinel
        // via edit_file(operation:"write"), then claim done again.
        .toolCall("edit_file", {
          operation: "write",
          path: ".ready",
          content: "ok\n",
          description: "mark ready",
        })
        .text("Now it is ready. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=hook-stop Finish the task.",
      mode: "build",
      during: async (ipc) => {
        // Approve the write that creates the sentinel.
        const permission: any = await ipc.waitFor(
          "permission-request",
          (p: any) => p?.chatId === chatId,
        );
        const executePermission = await getIpcHandler("execute-permission");
        await executePermission({} as any, {
          chatId,
          operationId: permission.payload.operationId,
        });
      },
      timeoutMs: 25_000,
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // The stop-hook failure was fed back (the turn did NOT end on round 1).
    const requests = ctx.server.requestsFor("hook-stop") as Array<unknown>;
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(requests)).toContain("stop-hook");

    ctx.ws.write(".atlarix/hooks/hooks.json", JSON.stringify({ hooks: [] }));
  }, 30_000);
});
