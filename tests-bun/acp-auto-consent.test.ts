/**
 * Free Atlarix Auto asks for the user's OK before its first turn. In Zed,
 * JetBrains and Atlarix's VS Code panel (all ACP) there was no way to give it:
 * the turn just failed with "Review and accept to keep going" (QA 15.7.1 #6b).
 * Now the editor gets a permission card with the consent's own words; yes runs
 * the same request again in that prompt, no keeps everything as it was.
 *
 * The proxy's refusal is stood in for by the session's first submit ending on
 * the consent error, exactly the state a real refusal leaves.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "acp-consent-ud-"),
  );
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "acp-consent-ws-"));
});

async function editor(answer: "accept" | "decline") {
  const llm = startFakeLlm([{ text: "Hello from Atlarix Auto." }]);
  const { AgentSession, seedDevProvider } = await import(
    "../src/cli/agent/session"
  );
  const { AcpAgent } = await import("../src/cli/acp/agent");
  const { buildAgentApp } = await import("../src/cli/acp/server");
  const { autoConsentRequiredUserMessage } = await import(
    "../src/shared/billing_copy"
  );
  const model = await seedDevProvider({
    baseUrl: llm.url,
    model: "fake-model",
    apiKey: "dev",
  });
  const accepted: string[] = [];
  const agent = new AcpAgent({
    createSession: async (cwd) => {
      const s = new AgentSession({
        workspaceDir: cwd,
        model,
        surface: "editor",
      });
      await s.start();
      const raw = s as unknown as { update(p: Record<string, unknown>): void };
      const submit = s.submit.bind(s);
      let consented = false;
      s.submit = async (text, opts) => {
        if (!consented)
          return raw.update({ lastError: autoConsentRequiredUserMessage() });
        return submit(text, opts);
      };
      s.acceptAutoConsent = async () => {
        consented = true;
        accepted.push("yes");
        raw.update({ lastError: null });
        await submit("hi");
      };
      return s;
    },
    models: async () => ({
      options: [{ ...model, label: "Fake" }],
      current: model,
    }),
    rememberModel: () => {},
    listSessions: async () => [],
    changeSession: async () => {},
  });
  const updates: SessionNotification[] = [];
  const asked: RequestPermissionRequest[] = [];
  const client = acp
    .client({ name: "test-editor" })
    .onRequest("session/request_permission", (ctx) => {
      asked.push(ctx.params);
      return { outcome: { outcome: "selected", optionId: answer } };
    })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params);
    });
  const conn = client.connect(buildAgentApp(agent, "test"));
  await conn.agent.request("initialize", {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const text = (id: string) =>
    updates
      .filter(
        (u) =>
          u.sessionId === id &&
          u.update.sessionUpdate === "agent_message_chunk",
      )
      .map(
        (u) => (u.update as { content: { text?: string } }).content.text ?? "",
      )
      .join("");
  return { conn, asked, accepted, text };
}

describe("free Atlarix Auto's consent in an editor", () => {
  it("asks with the consent's words; yes runs the request again", async () => {
    const e = await editor("accept");
    const { sessionId } = await e.conn.agent.request("session/new", {
      cwd: ws,
      mcpServers: [],
    });
    const r = await e.conn.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(r.stopReason).toBe("end_turn");
    expect(e.asked).toHaveLength(1);
    expect(e.asked[0]!.toolCall.title).toBe("Use Atlarix Auto for free?");
    expect(JSON.stringify(e.asked[0]!.toolCall.content)).toContain(
      "OpenRouter and Requesty",
    );
    expect(e.asked[0]!.options.map((o) => o.name)).toEqual([
      "Use Atlarix Auto",
      "Not now",
    ]);
    expect(e.accepted).toEqual(["yes"]);
    expect(e.text(sessionId)).toContain("Hello from Atlarix Auto.");
  }, 60_000);

  it("no keeps it as it was, and says how to come back to it", async () => {
    const e = await editor("decline");
    const { sessionId } = await e.conn.agent.request("session/new", {
      cwd: ws,
      mcpServers: [],
    });
    const r = await e.conn.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(r.stopReason).toBe("end_turn");
    expect(e.accepted).toEqual([]);
    expect(e.text(sessionId)).toContain("Atlarix Auto is free once you OK it.");
  }, 60_000);
});
