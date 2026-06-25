import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupEvalContext, getIpcHandler, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { runHeadlessAgent } from "@/headless/headless-runner";

/**
 * Proves the prod headless runner (`runHeadlessAgent`) drives the real loop +
 * unattended auto-approve + completion — in-process, no network. Electron is
 * mocked by the agent-evals project, so we inject `getIpcHandler` as the handler
 * resolver (the standalone bundle uses the electron-stub's registry instead).
 */
let ctx: EvalContext;
let wsDir: string;

beforeAll(async () => {
  ctx = await setupEvalContext();
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-hl-ws-"));
});

afterAll(async () => {
  await ctx.cleanup();
  fs.rmSync(wsDir, { recursive: true, force: true });
  // runHeadlessAgent sets these process-wide — clear them so they don't leak
  // into other agent-eval files (e.g. toolset-golden expects browser tools).
  delete process.env.ATLARIX_HEADLESS;
  delete process.env.ATLARIX_DISABLE_TEXT_TOOLS;
  delete process.env.ATLARIX_USER_DATA_DIR;
  delete process.env.ATLARIX_OPENROUTER_PROVIDER_JSON;
});

describe("headless runner (in-process, no network)", () => {
  it("runs the real loop, auto-approves a write, and completes", async () => {
    ctx.server.register(
      scenario("hl-smoke")
        .toolCall("edit_file", {
          path: "out.txt",
          content: "hello from headless\n",
          operation: "write",
          description: "create out.txt",
        })
        .text("Done.")
        .build(),
    );

    const res = await runHeadlessAgent({
      workspaceDir: wsDir,
      prompt: "sc=hl-smoke create out.txt",
      provider: { baseUrl: ctx.server.baseURL, model: "hl-model" },
      mode: "build",
      timeoutMs: 30_000,
      resolveHandler: (channel) => getIpcHandler(channel),
    });

    expect(res.completed).toBe(true);
    expect(fs.existsSync(path.join(wsDir, "out.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, "out.txt"), "utf8")).toContain(
      "hello from headless",
    );

    // Headless integrity: the autonomous surface drops tools that can't work or
    // are harmful with no human/UI in the loop, and a real tool still executed
    // (native FC). See resolve-toolset.ts HEADLESS_DROP + browser_* filter.
    const requests = ctx.server.requestsFor("hl-smoke") as Array<{
      tools?: Array<{ function?: { name?: string }; name?: string }>;
    }>;
    const offered = (requests[0]?.tools ?? []).map(
      (t) => t.function?.name ?? t.name ?? "",
    );
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.some((n) => n.startsWith("browser_"))).toBe(false);
    // ask_user (false-success deadlock), MCP, and the web/attachment tools must
    // NOT be offered headless.
    for (const dropped of [
      "ask_user",
      "mcp_call",
      "list_available_mcps",
      "web_search",
      "read_url",
      "read_attachment",
      "list_attachments",
    ]) {
      expect(offered).not.toContain(dropped);
    }
    // run_command (and other core workspace tools) MUST still be offered.
    expect(offered).toContain("run_command");
  }, 60_000);
});
