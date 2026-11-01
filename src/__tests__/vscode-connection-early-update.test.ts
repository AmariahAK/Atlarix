/**
 * A new chat's first updates arrive before the panel listens (QA E6): the agent
 * answers `session/new` and sends the command list right behind it, while the
 * panel is still reading the answer to learn the id. Those updates are held and
 * replayed on `listen`, so "/" has its menu in a new chat as it does in a
 * loaded one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AtlarixConnection } from "../../packages/vscode/src/connection";

const AGENT = `#!/usr/bin/env node
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i !== -1; i = buf.indexOf("\\n")) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    if (msg.method === "session/new") {
      send({ id: msg.id, result: { sessionId: "s-new" } });
      // The command list, straight behind the answer, as agent.ts does.
      send({ method: "session/update", params: { sessionId: "s-new", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact" }] } } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe.skipIf(process.platform === "win32")("updates sent before the panel listens", () => {
  it("are held and replayed on listen, so a new chat gets its command list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-early-"));
    const binary = path.join(dir, "atlarix");
    fs.writeFileSync(binary, AGENT, { mode: 0o755 });
    const c = new AtlarixConnection({ binary, cwd: dir, version: "test", log: () => {}, openUrl: () => {}, onExit: () => {} });
    try {
      await c.start();
      const r = await c.newSession(dir);
      expect(r.sessionId).toBe("s-new");
      // Let the update that followed the answer land before anyone listens.
      await new Promise((res) => setTimeout(res, 150));
      const got: unknown[] = [];
      c.listen("s-new", {
        update: (n) => got.push(n.update),
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
        peerWaiting: () => {},
      });
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ sessionUpdate: "available_commands_update" });
      // Replayed once: listening again starts empty.
      const again: unknown[] = [];
      c.listen("s-new", { update: (n) => again.push(n), permission: async () => ({ outcome: { outcome: "cancelled" } }), peerWaiting: () => {} });
      expect(again).toHaveLength(0);
    } finally {
      c.dispose();
    }
  });
});
