/**
 * /effort for editors (ACP): the "thinking" config option carries the chosen
 * model's own levels, exactly as listed (paid Auto's low / medium / max; none on
 * free Auto), setting it writes the level, and changing the model resets a
 * level the new model doesn't list (owner, 2026-10-17).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";

let ws: string;

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acp-effort-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  process.env.ATLARIX_PEER_SURFACE = "editor";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "acp-effort-ws-"));
});

const AUTO = { kind: "effort" as const, levels: ["low", "medium", "max"], defaultLevel: "medium" };
const GPT = { kind: "effort" as const, levels: ["none", "low", "medium", "high", "xhigh"], defaultLevel: "medium" };
const KIMI = { kind: "effort" as const, levels: ["low", "high", "max"], defaultLevel: "high" };
const OPTIONS = [
  { provider: "compass", name: "core-auto", label: "Atlarix Auto", free: true, effortChoices: AUTO },
  { provider: "openai", name: "gpt-5.4", label: "GPT-5.4", effortChoices: GPT },
  { provider: "local", name: "plain", label: "Plain" },
  { provider: "moonshotai", name: "kimi-k3", label: "Kimi K3", effortChoices: KIMI },
];

type Option = { id: string; currentValue: unknown; options: Array<{ value: string; description?: string }> };

async function editor(opts: { freeAccount?: boolean; current?: { provider: string; name: string }; offered?: typeof OPTIONS } = {}) {
  const { AgentSession } = await import("../src/cli/agent/session");
  const { AcpAgent } = await import("../src/cli/acp/agent");
  const { buildAgentApp } = await import("../src/cli/acp/server");
  let effort = { effort: "", deepThinking: false };
  const writes: Array<typeof effort> = [];
  const agent = new AcpAgent({
    createSession: async (cwd) => {
      const s = new AgentSession({ workspaceDir: cwd, model: opts.current ?? { provider: "compass", name: "core-auto" }, surface: "editor", idlePeerMessages: "hold" });
      await s.start();
      return s;
    },
    models: async () => ({ options: opts.offered ?? OPTIONS, current: opts.current ?? { provider: "compass", name: "core-auto" }, effort, freeAccount: opts.freeAccount }),
    rememberModel: () => {},
    setEffort: (patch) => {
      effort = patch;
      writes.push(patch);
    },
    listSessions: async () => [],
  });
  const conn = acp.client({ name: "t" }).connect(buildAgentApp(agent, "test"));
  await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const s = await conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
  const thinking = (list: unknown) => ((list as Option[]) ?? []).find((o) => o.id === "thinking");
  return { conn, sessionId: s.sessionId, initial: thinking(s.configOptions), thinking, writes };
}

describe("/effort over ACP", () => {
  it("paid Auto offers low / medium / max, the default marked", async () => {
    const e = await editor();
    expect(e.initial?.options.map((o) => o.value)).toEqual(["low", "medium", "max"]);
    expect(e.initial?.currentValue).toBe("medium");
    expect(e.initial?.options.find((o) => o.value === "medium")?.description).toBe("default");
  }, 30_000);

  it("free Auto offers none", async () => {
    const e = await editor({ freeAccount: true });
    expect(e.initial).toBeUndefined();
  }, 30_000);

  it("a model's own levels exactly as listed; choosing one writes it", async () => {
    const e = await editor({ current: { provider: "openai", name: "gpt-5.4" } });
    expect(e.initial?.options.map((o) => o.value)).toEqual(["none", "low", "medium", "high", "xhigh"]);
    const r = await e.conn.agent.request("session/set_config_option", { sessionId: e.sessionId, configId: "thinking", value: "xhigh" });
    expect(e.writes.at(-1)).toEqual({ effort: "xhigh", deepThinking: true });
    expect(e.thinking((r as { configOptions: unknown }).configOptions)?.currentValue).toBe("xhigh");
  }, 30_000);

  it("a level the new model lists too is kept", async () => {
    const e = await editor({ current: { provider: "openai", name: "gpt-5.4" } });
    await e.conn.agent.request("session/set_config_option", { sessionId: e.sessionId, configId: "thinking", value: "low" });
    await e.conn.agent.request("session/set_config_option", { sessionId: e.sessionId, configId: "model", value: "moonshotai/kimi-k3" });
    expect(e.writes.at(-1)).toEqual({ effort: "low", deepThinking: false });
  }, 30_000);

  it("nothing chosen stays nothing chosen across model changes (QA R1)", async () => {
    const e = await editor({ current: { provider: "openai", name: "gpt-5.4" } });
    await e.conn.agent.request("session/set_config_option", { sessionId: e.sessionId, configId: "model", value: "moonshotai/kimi-k3" });
    expect(e.writes.at(-1)).toEqual({ effort: "", deepThinking: false });
  }, 30_000);

  it("a session whose model is no longer offered sets the level of the one the picker shows (QA R3)", async () => {
    const e = await editor({ current: { provider: "gone", name: "removed" }, offered: OPTIONS.slice(1) });
    expect(e.initial?.options.map((o) => o.value)).toEqual(GPT.levels);
    await e.conn.agent.request("session/set_config_option", { sessionId: e.sessionId, configId: "thinking", value: "xhigh" });
    expect(e.writes.at(-1)).toEqual({ effort: "xhigh", deepThinking: true });
  }, 30_000);

  it("/effort typed in the chat is answered here, never sent to the model (QA N3)", async () => {
    const e = await editor({ current: { provider: "openai", name: "gpt-5.4" } });
    const listed = await e.conn.agent.request("session/prompt", { sessionId: e.sessionId, prompt: [{ type: "text", text: "/effort" }] });
    expect(listed.stopReason).toBe("end_turn");
    expect(e.writes).toEqual([]);
    await e.conn.agent.request("session/prompt", { sessionId: e.sessionId, prompt: [{ type: "text", text: "/effort xhigh" }] });
    expect(e.writes.at(-1)).toEqual({ effort: "xhigh", deepThinking: true });
  }, 30_000);

  it("changing to a model that doesn't list the level resets it", async () => {
    const e = await editor({ current: { provider: "openai", name: "gpt-5.4" } });
    await e.conn.agent.request("session/set_config_option", { sessionId: e.sessionId, configId: "thinking", value: "none" });
    await e.conn.agent.request("session/set_config_option", { sessionId: e.sessionId, configId: "model", value: "local/plain" });
    expect(e.writes.at(-1)).toEqual({ effort: "", deepThinking: false });
  }, 30_000);
});
