#!/usr/bin/env bun
/**
 * Smoke-test a compiled `atlarix` binary on the machine it was built for:
 * `--version`, then one batch turn (`atlarix run`) against the scripted fake
 * model (tests-bun/fixtures/fake-llm.ts) in a scratch folder. Every release leg
 * runs this before uploading (release.yml `build-cli`).
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
