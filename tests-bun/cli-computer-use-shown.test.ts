/**
 * 15.11.0 (ai-c8): computer use was switched on in the app, and the CLI on the
 * same profile then used the real screen with no sign of it (the switch is
 * shared, in user-settings.json). Switched on anywhere, the CLI's next turn
 * shows it: in its state (header and status line) and once at the turn's
 * start, and an editor's Computer use option and transcript say so too.
 *
 * Claude behind an Anthropic-format endpoint, as people add Bedrock: the real
 * eligibility check, which for such a provider needs the providers loaded
 * (QA E8: the first turn said off while it offered the tool).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeAnthropic, type FakeAnthropic } from "./fixtures/fake-anthropic";

const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
let ws: string;
let fake: FakeAnthropic;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "cli-cu-shown-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  // An executor "in the build" (never asked to act: the fake only answers in text).
  process.env.ATLARIX_COMPUTER_HELPER = process.execPath;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cu-shown-ws-"));
  process.chdir(ws);
  process.on("unhandledRejection", () => {});
  fake = startFakeAnthropic({ key: "dev", accepts: "x-api-key", reply: "Done." });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  await import("../src/headless/bundled-assets");
  const session = await import("../src/cli/agent/session");
  const model = await session.seedDevProvider({ baseUrl: fake.url, model: MODEL, apiKey: "dev", apiFormat: "anthropic" });
  const { writeSettings } = await import("../src/main/settings");
  const lane = await import("../src/lib/computer/lane");
  const switchOn = (on: boolean) => writeSettings({ computerUseModels: on ? [lane.computerUseKey(model)] : [] });
  return { ...session, model, lane, switchOn };
}

type Cells = ReadonlyArray<{ kind: string; text?: string; id: string }>;
const notices = (cells: Cells) => cells.filter((c) => c.kind === "notice" && c.text?.includes("Computer use on"));

/** Right under the turn's own message, before its reply (it came after the reply's footer: QA, ai-44). */
function expectUnderPrompt(cells: Cells, prompt: string) {
  const at = cells.findIndex((c) => c.kind === "notice" && c.text?.includes("Computer use on"));
  expect(cells[at - 1]).toMatchObject({ kind: "user", text: prompt });
  const reply = cells.findIndex((c, i) => i > at && c.kind === "markdown");
  expect(reply).toBeGreaterThan(at);
}

describe("computer use switched on outside the CLI", () => {
  it("already on when the CLI starts: its first turn says so (QA E8)", async () => {
    const { AgentSession, model, switchOn } = await setup();
    switchOn(true);
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    await s.submit("hi");
    for (let i = 0; i < 100 && s.state.busy; i++) await wait(100);
    expect(s.state.computerUse).toBe(true);
    expect(notices(s.state.cells).length).toBe(1);
    expectUnderPrompt(s.state.cells, "hi");
    switchOn(false);
  }, 60_000);

  it("switched on between turns: shown from the next turn, with a line at its start", async () => {
    const { AgentSession, model, switchOn } = await setup();
    switchOn(false);
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    await s.submit("hi");
    for (let i = 0; i < 100 && s.state.busy; i++) await wait(100);
    expect(s.state.computerUse).toBe(false);
    expect(notices(s.state.cells).length).toBe(0);

    // The app (another process, same profile) switches it on.
    switchOn(true);
    await s.submit("and now?");
    for (let i = 0; i < 100 && s.state.busy; i++) await wait(100);
    expect(s.state.computerUse).toBe(true);
    expect(notices(s.state.cells).length).toBe(1);
    expectUnderPrompt(s.state.cells, "and now?");
    switchOn(false);
  }, 60_000);
});

describe("over ACP (Zed, the VS Code panel)", () => {
  it("the editor's option and transcript follow a switch flipped elsewhere, from the next turn (QA E8)", async () => {
    const acp = await import("@agentclientprotocol/sdk");
    const { AgentSession, listFolderSessions, changeFolderSession, model, lane, switchOn } = await setup();
    const { AcpAgent } = await import("../src/cli/acp/agent");
    const { buildAgentApp } = await import("../src/cli/acp/server");
    switchOn(false);
    const agent = new AcpAgent({
      createSession: async (cwd) => {
        const s = new AgentSession({ workspaceDir: cwd, model, surface: "editor", idlePeerMessages: "hold" });
        await s.start();
        return s;
      },
      models: async () => ({ options: [{ ...model, label: "Claude", computerUse: "eligible" as const }], current: model }),
      rememberModel: () => {},
      listSessions: (cwd) => listFolderSessions(cwd),
      changeSession: (id, change) => changeFolderSession(id, change),
      computerUse: { isOn: (m) => lane.isComputerUseOn(m), set: (m, on) => lane.setComputerUse(m, on), notice: async () => null },
    });
    const updates: Array<{ sessionId: string; update: Record<string, unknown> & { sessionUpdate: string } }> = [];
    const conn = acp
      .client({ name: "test-editor" })
      .onNotification("session/update", (ctx) => {
        updates.push(ctx.params as never);
      })
      .connect(buildAgentApp(agent, "test"));
    await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const s = await conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const mine = () => updates.filter((u) => u.sessionId === s.sessionId).map((u) => u.update);
    const shown = () => {
      const last = mine().filter((u) => u.sessionUpdate === "config_option_update").at(-1) as
        | { configOptions: Array<{ id: string; currentValue: unknown }> }
        | undefined;
      return (last?.configOptions ?? s.configOptions)?.find((o) => o.id === "computer_use")?.currentValue;
    };
    expect(shown()).toBe("off");

    // Switched on in the app, mid-session.
    switchOn(true);
    await conn.agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] });
    await Bun.sleep(300);
    expect(shown()).toBe("on");
    expect(JSON.stringify(mine())).toContain("Computer use on. Move the mouse to stop it.");
    switchOn(false);
  }, 60_000);
});
