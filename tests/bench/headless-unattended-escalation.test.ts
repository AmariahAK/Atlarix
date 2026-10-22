import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupEvalContext, getIpcHandler, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { runHeadlessAgent } from "@/headless/headless-runner";

/**
 * A headless run whose command the sandbox stops from writing outside the
 * workspace used to block forever on a "grant write access" card nobody could
 * see (QA A3, 2026-10-22). It now ends, and the model reads why it was denied.
 */
let ctx: EvalContext;
let wsDir: string;
let outside: string;

beforeAll(async () => {
  ctx = await setupEvalContext();
  wsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-hl-esc-ws-")));
  // Under $HOME, not /tmp: the sandbox already lets every command write the temp folders.
  outside = fs.mkdtempSync(path.join(os.homedir(), ".atlarix-hl-esc-outside-"));
});

afterAll(async () => {
  await ctx.cleanup();
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  delete process.env.ATLARIX_HEADLESS;
  delete process.env.ATLARIX_DISABLE_TEXT_TOOLS;
  delete process.env.ATLARIX_USER_DATA_DIR;
});

describe.runIf(process.platform === "darwin" || process.platform === "linux")("headless sandbox denial", () => {
  it("ends the run with the denial instead of waiting for an approval", async () => {
    const target = path.join(outside, "x.txt");
    ctx.server.register(
      scenario("hl-unattended-esc")
        .toolCall("run_command", { command: `touch ${target}`, description: "write outside" })
        .text("Done.")
        .build(),
    );

    const started = Date.now();
    const res = await runHeadlessAgent({
      workspaceDir: wsDir,
      prompt: "sc=hl-unattended-esc write the file",
      provider: { baseUrl: ctx.server.baseURL, model: "hl-model" },
      mode: "build",
      timeoutMs: 20_000,
      resolveHandler: (channel) => getIpcHandler(channel),
    });

    expect(res.completed).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fs.existsSync(target)).toBe(false);
    const second = JSON.stringify(ctx.server.requestsFor("hl-unattended-esc")[1] ?? "");
    expect(second).toMatch(/No one is here to approve/);
  }, 30_000);
});
