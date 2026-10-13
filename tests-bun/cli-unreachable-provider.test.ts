/**
 * A provider nobody answers at (it's down, or the address is wrong): the turn
 * ends with that reason, not "Something went wrong" and not stuck working (QA).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let ws: string;

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "unreach-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "unreach-ws-"));
});

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("an unreachable provider", () => {
  it("ends the turn with the connection error", async () => {
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: `http://127.0.0.1:${await deadPort()}/v1`, model: "fake-model", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    await s.submit("say hi");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`turn never finished: ${JSON.stringify(s.state.lastError)}`)), 60_000);
      const check = () => {
        if (!s.state.busy && s.state.lastError) {
          clearTimeout(t);
          resolve();
        }
      };
      s.on("change", check);
      check();
    });
    expect(s.state.lastError).toContain("Couldn't reach the model provider");
    expect(s.state.lastError).not.toContain("Something went wrong");
  }, 70_000);
});
