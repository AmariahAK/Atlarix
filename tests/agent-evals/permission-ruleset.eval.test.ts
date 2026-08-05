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
 * The permission `deny` ruleset at the single tool-execution funnel
 * (runToolExecute), covering ask+build and native AND text-tool paths
 * uniformly: a deny rule returns a structured tool error the model sees, and
 * the workspace file merges over the global `~/.atlarix` one.
 *
 * Two hook cases lived here until v14.26.0 (a non-zero `pre_tool_use` denying a
 * tool, and a red `stop` hook blocking a prose-only completion). They went with
 * the hooks feature. The `ask` list this file never covered went in the same
 * release — it was only ever logged.
 *
 * No permissions file ⇒ behaviour identical to having none (the existing
 * edit-with-approval evals are that regression guard).
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

describe("permission ruleset — deny rules at the single funnel", () => {
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
        .text("Understood, blocked.")
        .repeatLast()
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
          .text("Understood, blocked.")
          .repeatLast()
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

});
