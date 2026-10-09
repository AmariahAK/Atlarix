#!/usr/bin/env bun
/**
 * Smoke-test a compiled `atlarix` binary on the machine it was built for:
 * `--version`, one batch turn (`atlarix run`), and one editor turn over ACP
 * (`atlarix acp`: JSON-RPC on stdio, and NOTHING else on stdout) against the
 * scripted fake model (tests-bun/fixtures/fake-llm.ts) in a scratch folder.
 * Every release leg runs this before uploading (release.yml `build-cli`).
 *
 * Usage: bun scripts/cli-smoke.ts <path-to-binary>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "../tests-bun/fixtures/fake-llm";

const bin = path.resolve(process.argv[2] ?? "dist-bun/atlarix");
const fail = (msg: string): never => {
  console.error(`cli-smoke: FAIL ${msg}`);
  process.exit(1);
};

const version = Bun.spawnSync([bin, "--version"]);
const vOut = version.stdout.toString().trim();
if (version.exitCode !== 0 || !/\d+\.\d+\.\d+/.test(vOut)) fail(`--version: exit ${version.exitCode}, "${vOut}"`);
console.log(`cli-smoke: --version → ${vOut}`);

const llm = startFakeLlm([{ text: "Smoke test passed." }]);
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-smoke-ws-"));
const out = path.join(ws, "out.json");
const run = Bun.spawn(
  [bin, "run", "--prompt", "say hi", "--provider-url", llm.url, "--model", "fake-model", "--api-key", "x", "--workspace", ws, "--mode", "ask", "--output-file", out],
  { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATLARIX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cli-smoke-ud-")) } },
);
const timer = setTimeout(() => run.kill(), 120_000);
const code = await run.exited;
clearTimeout(timer);
llm.stop();
const body = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
if (code !== 0) fail(`run exited ${code}\n${await new Response(run.stderr).text()}`);
if (!body.includes("Smoke test passed.")) fail(`run output did not contain the model's reply:\n${body.slice(0, 2000)}`);
console.log("cli-smoke: run → ok");

// `atlarix acp`, as an editor runs it: initialize, a session, one prompt.
const acpLlm = startFakeLlm([{ text: "ACP smoke passed." }]);
const acpWs = fs.mkdtempSync(path.join(os.tmpdir(), "cli-smoke-acp-ws-"));
const acp = Bun.spawn([bin, "acp", "--provider-url", acpLlm.url, "--model", "fake-model", "--api-key", "x"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, ATLARIX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cli-smoke-acp-ud-")) },
});
const send = (msg: object) => {
  acp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  acp.stdin.flush();
};
const lines: string[] = [];
const acpTimer = setTimeout(() => acp.kill(), 120_000);
const reader = (async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of acp.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      lines.push(line);
      let msg: { jsonrpc?: string; id?: number; result?: { sessionId?: string; stopReason?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        fail(`acp: stdout is not JSON-RPC: ${line.slice(0, 200)}`);
        return;
      }
      if (msg.jsonrpc !== "2.0") fail(`acp: stdout is not JSON-RPC: ${line.slice(0, 200)}`);
      if (msg.id === 1) send({ id: 2, method: "session/new", params: { cwd: acpWs, mcpServers: [] } });
      if (msg.id === 2 && msg.result?.sessionId) {
        send({ id: 3, method: "session/prompt", params: { sessionId: msg.result.sessionId, prompt: [{ type: "text", text: "say hi" }] } });
      }
      if (msg.id === 3) return msg.result?.stopReason;
    }
  }
})();
send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
const stop = await reader;
clearTimeout(acpTimer);
acp.kill();
acpLlm.stop();
if (stop !== "end_turn") fail(`acp: prompt ended "${stop}"\n${(await new Response(acp.stderr).text()).slice(-2000)}`);
// The reply streams in word-sized chunks: join what the editor was sent.
const said = lines
  .map((l) => JSON.parse(l) as { method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } })
  .filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk")
  .map((m) => m.params!.update!.content?.text ?? "")
  .join("");
if (!said.includes("ACP smoke passed.")) fail(`acp: the model's reply never reached the editor (got "${said.slice(0, 200)}")`);
console.log("cli-smoke: acp → ok");
