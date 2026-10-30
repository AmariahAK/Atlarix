import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";
import { userHooksPath } from "@/lib/plugins/paths";

/**
 * Hooks end to end, through a real turn: a non-zero `pre_tool_use` hook denies a
 * tool and the model sees why; a red `stop` hook keeps a prose-only completion
 * going until it passes.
 *
 * These two cases lived in `permission-ruleset.eval.test.ts` until v14.26.0,
 * against `.atlarix/hooks/hooks.json` in the WORKSPACE — the shape that let a
 * repository's file run as shell. Since 15.12 hooks come only from the person's
 * `<atlarixHomeDir>/hooks.json` and installed plugins, so that is what is
 * written here, and the last case checks a workspace file does nothing.
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

afterEach(() => {
  fs.rmSync(userHooksPath(), { force: true });
});

function writeUserHooks(hooks: unknown[]) {
  fs.mkdirSync(path.dirname(userHooksPath()), { recursive: true });
  fs.writeFileSync(userHooksPath(), JSON.stringify({ hooks }));
}

describe("hooks (the person's hooks.json) at the funnel and the stop gate", () => {
  it("a non-zero pre_tool_use hook denies the tool and the model sees its output", async () => {
    writeUserHooks([
      {
        event: "pre_tool_use",
        match: "run_command",
        command: "echo 'policy: no shell here' 1>&2; exit 1",
      },
    ]);
    ctx.server.register(
      scenario("user-hook-deny")
        .toolCall("run_command", { command: "ls", description: "list" })
        .text("Blocked by hook.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=user-hook-deny List files.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("user-hook-deny"));
    expect(blob).toContain("Blocked by an edict");
    expect(blob).toContain("policy: no shell here");
  }, 30_000);

  it("a stop hook blocks a natural completion until it passes", async () => {
    // Red until `.ready` exists in the workspace; the model "fixes" it by writing it.
    writeUserHooks([
      {
        event: "stop",
        command: "test -f .ready || (echo 'tests not green' 1>&2; exit 1)",
      },
    ]);
    ctx.server.register(
      scenario("user-hook-stop")
        .text("All done.")
        .toolCall("edit_file", {
          operation: "write",
          path: ".ready",
          content: "ok\n",
          description: "mark ready",
        })
        .text("Now it is ready.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=user-hook-stop Finish the task.",
      mode: "build",
      during: async (ipc) => {
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

    const requests = ctx.server.requestsFor("user-hook-stop") as Array<unknown>;
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(requests)).toContain("tests not green");

    // The two answers are two paragraphs, not "All done.Now it is ready."
    const lastFull = [...fakeIpc.sends]
      .reverse()
      .find(
        (s: any) =>
          s.channel === "chat:response:chunk" &&
          s.payload?.chatId === chatId &&
          Array.isArray(s.payload?.messages),
      ) as any;
    const reply =
      (lastFull?.payload.messages as Array<{ role: string; content?: string }>)
        .filter((m) => m.role === "assistant")
        .at(-1)?.content ?? "";
    expect(reply).toContain("All done.\n\n");
    expect(reply).not.toContain("All done.Now");
  }, 30_000);

  it("a workspace's .atlarix hooks file runs nothing", async () => {
    ctx.ws.write(
      ".atlarix/hooks/hooks.json",
      JSON.stringify({
        hooks: [
          { event: "pre_tool_use", command: "echo REPO_HOOK_RAN 1>&2; exit 1" },
        ],
      }),
    );
    ctx.ws.write(
      ".atlarix/hooks.json",
      JSON.stringify({
        hooks: [
          { event: "pre_tool_use", command: "echo REPO_HOOK_RAN 1>&2; exit 1" },
        ],
      }),
    );
    ctx.server.register(
      scenario("repo-hook-ignored")
        .toolCall("read_file", { path: "src/info.ts" })
        .text("Read it.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=repo-hook-ignored Read info.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    const blob = JSON.stringify(ctx.server.requestsFor("repo-hook-ignored"));
    expect(blob).not.toContain("REPO_HOOK_RAN");
    expect(blob).toContain("export const info");
  }, 30_000);
});
