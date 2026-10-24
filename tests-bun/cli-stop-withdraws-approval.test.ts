/**
 * 15.11.0 (ai-c8; ai-26 E7 over ACP): stopping a turn with an approval open
 * left the approval in the session, so the CLI kept its card and an editor
 * never got $/cancel_request (the editor takes a card back when its approval
 * leaves this list). Esc withdraws them.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "cli-stop-approval-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-stop-approval-ws-"));
  process.chdir(ws);
  process.on("unhandledRejection", () => {});
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Esc with an approval open", () => {
  it("leaves no approval behind", async () => {
    const llm = startFakeLlm([
      { tool: "edit_file", args: { operation: "write", path: "ants.js", content: "x\n", description: "add ants" } },
      { text: "Done." },
    ]);
    await import("../src/headless/bundled-assets");
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    void s.submit("add the ants module");
    for (let i = 0; i < 200 && s.state.approvals.length === 0; i++) await wait(100);
    expect(s.state.approvals.length).toBe(1);
    await s.interrupt();
    for (let i = 0; i < 50 && s.state.busy; i++) await wait(100);
    expect(s.state.approvals).toEqual([]);
    expect(fs.existsSync(path.join(ws, "ants.js"))).toBe(false);
  }, 60_000);
});
