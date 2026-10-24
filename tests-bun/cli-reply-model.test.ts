/**
 * 15.11.0 (ai-c8, filming): the app labelled a CLI reply with its own picker's
 * model, because the CLI saved replies with no record of the model. A finished
 * CLI turn saves the model it ran on with the reply.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "cli-reply-model-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-reply-model-ws-"));
  process.chdir(ws);
  process.on("unhandledRejection", () => {});
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a CLI reply keeps its model", () => {
  it("the saved reply's display snapshot names the model the turn ran on", async () => {
    const llm = startFakeLlm([{ text: "Ready." }, { text: "Ready" }]);
    await import("../src/headless/bundled-assets");
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const { handler } = await import("../src/cli/agent/ipc");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-haiku", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    await s.submit("Just reply: ready.");
    for (let i = 0; i < 300 && (s.state.busy || !s.sessionId); i++) await wait(100);
    await wait(300);
    const got = (await (await handler("sessions:get"))({}, s.sessionId)) as {
      messages: Array<{ role: string; displaySnapshot?: unknown }>;
    };
    const saved = got.messages.filter((m) => m.role === "assistant").at(-1);
    expect(saved).toBeTruthy();
    const { parseDisplaySnapshot } = await import("../src/lib/chat/display-snapshot");
    const snap = parseDisplaySnapshot(saved!.displaySnapshot as never);
    expect(snap?.model).toEqual({ provider: model.provider, name: model.name });
  }, 60_000);
});
