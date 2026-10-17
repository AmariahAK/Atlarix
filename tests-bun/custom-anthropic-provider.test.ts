/**
 * A provider the user added on the Anthropic format, end to end: added through
 * the editor's `_atlarix/provider_custom` (the same `addCustom` the terminal's
 * /connect and the VS Code panel use), then a real turn through it.
 *
 * The fake endpoint takes the key only as a Bearer token, like Bedrock's
 * /anthropic endpoint and many gateways, so adding it has to find that out and
 * every later request has to send it that way.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { startFakeAnthropic } from "./fixtures/fake-anthropic";

let ws: string;

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "anth-ud-"));
  // A scratch data folder with no sign-in: a turn on your own provider needs none.
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  process.env.ATLARIX_PEER_SURFACE = "editor";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "anth-ws-"));
});

async function editorServer() {
  const { initializeDatabase } = await import("../src/db");
  initializeDatabase();
  const { AcpAgent } = await import("../src/cli/acp/agent");
  const { buildAgentApp } = await import("../src/cli/acp/server");
  const agent = new AcpAgent({
    createSession: async () => {
      throw new Error("not used");
    },
    models: async () => ({ options: [], current: undefined as never }),
    rememberModel: () => {},
    listSessions: () => [],
    changeSession: () => {},
  } as never);
  const conn = acp.client({ name: "test-editor" }).connect(buildAgentApp(agent, "test"));
  await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  return conn;
}

/** Wait for the session's turn to end. */
function idle(s: { state: { busy: boolean }; on: (e: string, f: () => void) => void; off: (e: string, f: () => void) => void }, ms = 60_000) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("turn never finished")), ms);
    const check = () => {
      if (!s.state.busy) {
        clearTimeout(t);
        s.off("change", check);
        resolve();
      }
    };
    s.on("change", check);
  });
}

describe("a provider you added that speaks the Anthropic format", () => {
  it("is added from the editor with its key header found, lists its models, and answers a turn", async () => {
    const fake = startFakeAnthropic({ key: "tok-secret-123", accepts: "bearer", reply: "Hi from Anthropic format." });
    try {
      const conn = await editorServer();
      const r = await conn.agent.request<{ id: string; models: number }>("_atlarix/provider_custom", {
        name: "My Gateway",
        baseUrl: fake.url,
        key: "tok-secret-123",
        apiFormat: "anthropic",
      });
      expect(r).toEqual({ id: "custom::my-gateway", models: 1 });

      // x-api-key was tried first and refused; Bearer was kept.
      const listed = await conn.agent.request<{ providers: Array<{ id: string; apiFormat?: string; custom?: boolean }> }>(
        "_atlarix/providers",
        {},
      );
      expect(listed.providers.find((p) => p.id === r.id)).toMatchObject({ custom: true, apiFormat: "anthropic" });
      const { getLanguageModelProviders } = await import("../src/ipc/shared/language_model_helpers");
      expect((await getLanguageModelProviders()).find((p) => p.id === r.id)).toMatchObject({
        apiFormat: "anthropic",
        authHeader: "bearer",
        npm: "@ai-sdk/anthropic",
      });

      const before = fake.requests.length;
      const { AgentSession } = await import("../src/cli/agent/session");
      const s = new AgentSession({ workspaceDir: ws, model: { provider: r.id, name: "claude-haiku-4-5" } });
      await s.start();
      const done = idle(s as never);
      await s.submit("Say hi.");
      await done;
      expect(s.state.lastError ?? null).toBeNull();
      expect(JSON.stringify(s.state)).toContain("Hi from Anthropic format.");

      const turn = fake.requests.slice(before).filter((q) => q.path === "/v1/messages");
      expect(turn.length).toBeGreaterThan(0);
      for (const q of turn) {
        expect(q.headers.authorization).toBe("Bearer tok-secret-123");
        expect(q.headers["x-api-key"]).toBeUndefined();
        expect(q.headers["anthropic-version"]).toBeTruthy();
      }
      // The main turn speaks the Messages API: a system prompt and tools, in Anthropic's shape.
      const main = turn.find((q) => Array.isArray(q.body?.tools) && (q.body!.tools as unknown[]).length > 0);
      expect(main?.body?.model).toBe("claude-haiku-4-5");
      expect(main?.body?.stream).toBe(true);
      expect((main?.body?.tools as Array<{ input_schema?: unknown }>)[0]!.input_schema).toBeTruthy();
    } finally {
      fake.stop();
    }
  }, 90_000);

  it("an endpoint that lists no models asks for a model id, then saves it", async () => {
    const fake = startFakeAnthropic({ key: "k2", accepts: "x-api-key", noModelList: true });
    try {
      const conn = await editorServer();
      const err = await conn.agent
        .request("_atlarix/provider_custom", { name: "No List", baseUrl: fake.url, key: "k2", apiFormat: "anthropic" })
        .catch((e: { data?: { needsModel?: boolean } }) => e);
      expect((err as { data?: { needsModel?: boolean } }).data?.needsModel).toBe(true);
      const r = await conn.agent.request<{ id: string; models: number }>("_atlarix/provider_custom", {
        name: "No List",
        baseUrl: fake.url,
        key: "k2",
        apiFormat: "anthropic",
        models: ["us.anthropic.claude-haiku-4-5-20251001-v1:0"],
      });
      expect(r).toEqual({ id: "custom::no-list", models: 1 });
    } finally {
      fake.stop();
    }
  }, 60_000);

  it("`--provider-url … --provider-format anthropic` (dev mode, no account) runs turns on that format", async () => {
    const fake = startFakeAnthropic({ key: "dev-k", accepts: "bearer", reply: "Dev mode on Anthropic format." });
    try {
      const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
      const model = await seedDevProvider({ baseUrl: fake.url, model: "claude-haiku-4-5", apiKey: "dev-k", apiFormat: "anthropic" });
      const s = new AgentSession({ workspaceDir: ws, model });
      await s.start();
      const done = idle(s as never);
      await s.submit("Say hi.");
      await done;
      expect(s.state.lastError ?? null).toBeNull();
      expect(JSON.stringify(s.state)).toContain("Dev mode on Anthropic format.");
      const turn = fake.requests.filter((q) => q.path === "/v1/messages");
      expect(turn.length).toBeGreaterThan(0);
      expect(turn.every((q) => q.headers.authorization === "Bearer dev-k")).toBe(true);

      // A second turn: the cached system block is byte-for-byte the first
      // turn's, and this turn's request rides in its own block after it (QA:
      // it sat inside the cached block, so every turn missed the cache).
      const before = fake.requests.length;
      const again = idle(s as never);
      await s.submit("Now read notes.txt.");
      await again;
      type Sys = Array<{ text: string; cache_control?: unknown }>;
      const mainOf = (qs: typeof fake.requests) =>
        qs.find((q) => q.path === "/v1/messages" && Array.isArray(q.body?.tools) && (q.body!.tools as unknown[]).length > 0)!;
      const first = mainOf(fake.requests.slice(0, before)).body!.system as Sys;
      const second = mainOf(fake.requests.slice(before)).body!.system as Sys;
      expect(first[0]!.cache_control).toBeTruthy();
      expect(second[0]!.text).toBe(first[0]!.text);
      expect(first[0]!.text).not.toContain("<user_context>");
      expect(second.slice(1).map((b) => b.text).join("\n")).toContain("Now read notes.txt.");
    } finally {
      fake.stop();
    }
  }, 90_000);

  it("a key the endpoint refuses changes nothing: not with model ids given, not as a replacement (QA A3, #1)", async () => {
    const fake = startFakeAnthropic({ key: "good-key", accepts: "bearer", noModelList: true });
    try {
      const conn = await editorServer();
      const refused = await conn.agent
        .request("_atlarix/provider_custom", { name: "Strict", baseUrl: fake.url, key: "wrong-key", apiFormat: "anthropic", models: ["claude-haiku-4-5"] })
        .catch((e: Error) => e);
      expect(String((refused as Error).message)).toContain("rejected");
      const r = await conn.agent.request<{ id: string }>("_atlarix/provider_custom", {
        name: "Strict",
        baseUrl: fake.url,
        key: "good-key",
        apiFormat: "anthropic",
        models: ["claude-haiku-4-5"],
      });
      const replaced = await conn.agent
        .request("_atlarix/provider_key", { providerId: r.id, key: "another-wrong-key" })
        .catch((e: Error) => e);
      expect(String((replaced as Error).message)).toContain("rejected");
      const { readSettings } = await import("../src/main/settings");
      expect((readSettings() as { providerSettings?: Record<string, { apiKey?: { value?: string } }> }).providerSettings?.[r.id]?.apiKey?.value).toBe(
        "good-key",
      );
    } finally {
      fake.stop();
    }
  }, 60_000);

  it("refuses a format it doesn't know", async () => {
    const conn = await editorServer();
    const err = await conn.agent
      .request("_atlarix/provider_custom", { name: "X", baseUrl: "http://127.0.0.1:1/v1", key: "", apiFormat: "gemini" })
      .catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/Unknown API format|Invalid params/);
  });
});
