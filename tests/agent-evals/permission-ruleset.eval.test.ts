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


  it("a retired tool name executes, and a rule on the CURRENT name still blocks it", async () => {
    // TWO defects found together while consolidating browser 6→2 (v14.41).
    //
    // 1. The registry's alias map made `browser_navigate` resolve to `browser`,
    //    but the text-tool dispatch compared the model's name against the
    //    ToolSet — which advertises canonical names only — so the alias died as
    //    "Unknown tool" and the map was decorative on the one path that could
    //    have used it. Text tools are the fallback for models WITHOUT native
    //    tool calling: exactly the population most likely to emit a stale name.
    // 2. Once it DOES resolve, the permission gate had to be told, or a user
    //    rule denying `browser` would be bypassed by the retired name — the
    //    ruleset is a pure string matcher and knows nothing about aliases.
    //
    // Driven through the real funnel, because neither defect was in the matcher
    // or the alias map; both were in what the call site passed along.
    process.env.ATLARIX_FORCE_TEXT_TOOLS = "1";
    ctx.ws.write(
      ".atlarix/permissions.json",
      JSON.stringify({ deny: ["browser"] }),
    );
    ctx.server.register(
      scenario("alias-bypass")
        .text(
          'Opening the page.\n<tool_call name="browser_navigate">{"url": "http://localhost:3000/admin"}</tool_call>',
        )
        .text("Blocked — I will not retry that call.")
        .text("Blocked.")
        .text("Blocked.")
        .text("Blocked.")
        .build(),
    );

    const chatId = await ctx.newChat();
    let fakeIpc;
    try {
      ({ fakeIpc } = await runTurn(ctx, {
        chatId,
        prompt: "sc=alias-bypass Open the admin page.",
        mode: "build",
      }));
    } finally {
      delete process.env.ATLARIX_FORCE_TEXT_TOOLS;
    }
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("alias-bypass"));
    // The alias RESOLVED (it reached the gate rather than dying as unknown)...
    expect(blob).not.toContain('Unknown tool "browser_navigate"');
    // ...and the gate caught it under the canonical name's rule.
    expect(blob).toContain("Blocked by permission rule");

    ctx.ws.write(".atlarix/permissions.json", JSON.stringify({ deny: [] }));
  }, 30_000);


  it("a rule written against a RETIRED name keeps blocking it", async () => {
    // The other direction, and the reason the gate checks BOTH names rather
    // than canonicalising once: making the alias executable would otherwise
    // have silently voided every deny rule a user had already written against
    // an old name. Before v14.41 such a call failed as "Unknown tool" so the
    // rule was moot; now it runs, so the rule has to bite.
    process.env.ATLARIX_FORCE_TEXT_TOOLS = "1";
    ctx.ws.write(
      ".atlarix/permissions.json",
      JSON.stringify({ deny: ["browser_navigate"] }),
    );
    ctx.server.register(
      scenario("legacy-rule")
        .text(
          'Opening the page.\n<tool_call name="browser_navigate">{"url": "http://localhost:3000/admin"}</tool_call>',
        )
        .text("Blocked — I will not retry that call.")
        .text("Blocked.")
        .text("Blocked.")
        .text("Blocked.")
        .build(),
    );

    const chatId = await ctx.newChat();
    let fakeIpc;
    try {
      ({ fakeIpc } = await runTurn(ctx, {
        chatId,
        prompt: "sc=legacy-rule Open the admin page.",
        mode: "build",
      }));
    } finally {
      delete process.env.ATLARIX_FORCE_TEXT_TOOLS;
    }
    expectStreamEnded(fakeIpc.sends, chatId);

    const blob = JSON.stringify(ctx.server.requestsFor("legacy-rule"));
    expect(blob).toContain("Blocked by permission rule");
    expect(blob).toContain("browser_navigate");

    ctx.ws.write(".atlarix/permissions.json", JSON.stringify({ deny: [] }));
  }, 30_000);

});
