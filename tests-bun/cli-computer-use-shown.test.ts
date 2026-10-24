/**
 * 15.11.0 (ai-c8): computer use was switched on in the app, and the CLI on the
 * same profile then used the real screen with no sign of it (the switch is
 * shared, in user-settings.json). Switched on anywhere, the CLI's next turn
 * shows it: in its state (header and status line) and once at the turn's start.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

// A scratch profile before anything that reads settings is imported (below).
process.env.ATLARIX_USER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "cli-cu-shown-ud-"));
process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
process.env.ATLARIX_SURFACE = "cli";

let ws: string;
beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cu-shown-ws-"));
  process.chdir(ws);
  process.on("unhandledRejection", () => {});
});

// Which models CAN have computer use is lane.ts's own concern (computer-use
// tests); the fake endpoint's model can't see images. Here the switch alone
// decides, and everything the CLI does with the answer is real.
const lane = await import("../src/lib/computer/lane");
mock.module("../src/lib/computer/lane", () => ({
  ...lane,
  computerLane: (m: { provider?: string; name?: string }) => (lane.isComputerUseOn(m) ? "own" : null),
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("computer use switched on outside the CLI", () => {
  it("is shown from the next turn, with a line at its start", async () => {
    const llm = startFakeLlm([{ text: "Hello." }, { text: "Hello again." }]);
    await import("../src/headless/bundled-assets");
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "claude-haiku-4-5", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();

    await s.submit("hi");
    for (let i = 0; i < 100 && s.state.busy; i++) await wait(100);
    expect(s.state.computerUse).toBe(false);
    expect(JSON.stringify(s.state.cells)).not.toContain("Computer use on");

    // The app (another process, same profile) switches it on.
    const { writeSettings } = await import("../src/main/settings");
    writeSettings({ computerUseModels: [`${model.provider}/${model.name}`] });

    await s.submit("and now?");
    for (let i = 0; i < 100 && s.state.busy; i++) await wait(100);
    expect(s.state.computerUse).toBe(true);
    const notes = s.state.cells.filter((c) => c.kind === "notice" && c.text.includes("Computer use on"));
    expect(notes.length).toBe(1);
  }, 60_000);
});

describe("over ACP (Zed, the VS Code panel)", () => {
  it("the editor's Computer use option follows a switch flipped elsewhere, from the next turn", async () => {
    const acp = await import("@agentclientprotocol/sdk");
    const llm = startFakeLlm([{ text: "One." }, { text: "Two." }]);
    const { AgentSession, seedDevProvider, listFolderSessions, changeFolderSession } = await import("../src/cli/agent/session");
    const { AcpAgent } = await import("../src/cli/acp/agent");
    const { buildAgentApp } = await import("../src/cli/acp/server");
    const { writeSettings } = await import("../src/main/settings");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-acp-model", apiKey: "dev" });
    writeSettings({ computerUseModels: [] });
    const agent = new AcpAgent({
      createSession: async (cwd) => {
        const s = new AgentSession({ workspaceDir: cwd, model, surface: "editor", idlePeerMessages: "hold" });
        await s.start();
        return s;
      },
      models: async () => ({ options: [{ ...model, label: "Fake", computerUse: "eligible" as const }], current: model }),
      rememberModel: () => {},
      listSessions: (cwd) => listFolderSessions(cwd),
      changeSession: (id, change) => changeFolderSession(id, change),
      computerUse: { isOn: (m) => lane.isComputerUseOn(m), set: (m, on) => lane.setComputerUse(m, on), notice: async () => null },
    });
    const updates: Array<{ sessionId: string; update: { sessionUpdate: string; configOptions?: Array<{ id: string; currentValue: unknown }> } }> = [];
    const conn = acp
      .client({ name: "test-editor" })
      .onNotification("session/update", (ctx) => {
        updates.push(ctx.params as never);
      })
      .connect(buildAgentApp(agent, "test"));
    await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const s = await conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const shown = () =>
      (updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "config_option_update").at(-1)?.update
        .configOptions ?? s.configOptions)?.find((o) => o.id === "computer_use")?.currentValue;
    expect(shown()).toBe("off");

    // Switched on in the app, mid-session.
    writeSettings({ computerUseModels: [`${model.provider}/${model.name}`] });
    await conn.agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] });
    await Bun.sleep(300);
    expect(shown()).toBe("on");
  }, 60_000);
});
