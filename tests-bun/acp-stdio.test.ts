/**
 * `atlarix acp` the way an editor runs it: a child process speaking JSON-RPC
 * over its stdin/stdout, against a scripted local model.
 *
 * Two things only a real process shows:
 * - stdout carries NOTHING but JSON-RPC (one stray log line breaks the editor's
 *   parser), with every module's logging loaded;
 * - cancel ends the turn as "cancelled", and the abort's leftover rejections
 *   stay inside the child (the CLI's process guards), as in a real editor.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { startFakeLlm, type FakeLlm } from "./fixtures/fake-llm";

let llm: FakeLlm;
let proc: ReturnType<typeof Bun.spawn>;
const stdoutLines: string[] = [];
const updates: SessionNotification[] = [];
let agent: acp.ClientConnection["agent"];
let ws: string;

beforeAll(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "acp-stdio-ws-"));
  llm = startFakeLlm([
    { text: "Hello over stdio." },
    { text: "A long answer that streams slowly enough to be stopped part way through.", delayMs: 150 },
  ]);
  proc = Bun.spawn(
    ["bun", "--preload", "./tests-bun/preload.ts", "src/cli/entry.mts", "acp", "--provider-url", llm.url, "--model", "fake-model"],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, ATLARIX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "acp-stdio-ud-")) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [forSdk, forCheck] = (proc.stdout as ReadableStream<Uint8Array>).tee();
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of forCheck) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        stdoutLines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
  })();
  const sink = proc.stdin as import("bun").FileSink;
  const toChild = new WritableStream<Uint8Array>({
    write(chunk) {
      sink.write(chunk);
      sink.flush();
    },
  });
  const conn = acp
    .client({ name: "test-editor" })
    .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }))
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params);
    })
    .connect(acp.ndJsonStream(toChild, forSdk));
  agent = conn.agent;
  await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
}, 60_000);

afterAll(() => {
  proc?.kill();
});

const textOf = (sessionId: string) =>
  updates
    .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => ((u.update as { content: { text?: string } }).content.text ?? ""))
    .join("");

describe("atlarix acp over stdio", () => {
  it("runs a turn, then cancels the next one as cancelled", async () => {
    const { sessionId } = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    const first = await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(first.stopReason).toBe("end_turn");
    expect(textOf(sessionId)).toContain("Hello over stdio.");

    const before = textOf(sessionId).length;
    const turn = agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "talk" }] });
    const t0 = Date.now();
    while (textOf(sessionId).length === before && Date.now() - t0 < 20_000) await Bun.sleep(50);
    await agent.notify("session/cancel", { sessionId });
    expect((await turn).stopReason).toBe("cancelled");
  }, 60_000);

  it("stdout carried nothing but JSON-RPC", () => {
    expect(stdoutLines.length).toBeGreaterThan(3);
    for (const line of stdoutLines.filter((l) => l.trim())) {
      let msg: { jsonrpc?: string } | null = null;
      try {
        msg = JSON.parse(line);
      } catch {
        /* reported below */
      }
      expect(msg?.jsonrpc, `not JSON-RPC on stdout: ${line.slice(0, 200)}`).toBe("2.0");
    }
  });
});
