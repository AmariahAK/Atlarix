/**
 * Closing VS Code (or the panel restarting its agent): the agent is told by
 * EOF, so it closes its sessions and runs its exit sweep before it exits. It
 * was killed outright, and on Windows kill() is TerminateProcess: the sweep
 * and the temp lease's release never ran (QA E11).
 *
 * The fake agent answers `initialize`, and leaves a mark only when its stdin
 * ends. Killed (SIGTERM here, TerminateProcess on Windows) it leaves none.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AtlarixConnection } from "../../packages/vscode/src/connection";

const AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const mark = process.env.FAKE_AGENT_MARK;
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i !== -1; i = buf.indexOf("\\n")) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }) + "\\n");
    }
  }
});
process.stdin.on("end", () => {
  fs.writeFileSync(mark, "eof");
  // One that hangs on the way out: the panel still ends it.
  if (process.env.FAKE_AGENT_HANG) setInterval(() => {}, 1000);
  else process.exit(0);
});
`;

describe.skipIf(process.platform === "win32")("the panel's agent, when the panel lets it go", () => {
  it("is told by EOF, so it exits on its own and cleans up", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-dispose-"));
    const binary = path.join(dir, "atlarix");
    fs.writeFileSync(binary, AGENT, { mode: 0o755 });
    const mark = path.join(dir, "mark");
    process.env.FAKE_AGENT_MARK = mark;
    let exited: (code: number | null) => void = () => {};
    const exit = new Promise<number | null>((r) => (exited = r));
    const c = new AtlarixConnection({ binary, cwd: dir, version: "test", log: () => {}, openUrl: () => {}, onExit: (code) => exited(code) });
    try {
      await c.start();
      c.dispose();
      expect(await exit).toBe(0);
      expect(fs.existsSync(mark)).toBe(true);
    } finally {
      delete process.env.FAKE_AGENT_MARK;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("is killed after a while if it hangs on its way out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-dispose-"));
    const binary = path.join(dir, "atlarix");
    fs.writeFileSync(binary, AGENT, { mode: 0o755 });
    process.env.FAKE_AGENT_MARK = path.join(dir, "mark");
    process.env.FAKE_AGENT_HANG = "1";
    let exited: (signalled: boolean) => void = () => {};
    const exit = new Promise<boolean>((r) => (exited = r));
    const c = new AtlarixConnection({ binary, cwd: dir, version: "test", log: () => {}, openUrl: () => {}, onExit: (code) => exited(code === null) });
    try {
      await c.start();
      const t0 = Date.now();
      c.dispose();
      expect(await exit).toBe(true);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4_500);
    } finally {
      delete process.env.FAKE_AGENT_MARK;
      delete process.env.FAKE_AGENT_HANG;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
