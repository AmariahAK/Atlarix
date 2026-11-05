/**
 * A session that already had a turn, then gets a message from another session
 * while idle: the turn the message opens must reach its screen, the incoming
 * message AND the reply (owner, 2026-11-06: "we dont actually see the messages";
 * live QA: the woken turn ran and was saved, but the CLI never drew it).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "peer-shows-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "peer-shows-ws-"));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 30_000) => {
  for (let i = 0; i < ms / 100 && !ok(); i++) await wait(100);
};

describe("a peer message into an idle session that already had a turn", () => {
  it("shows the message and the reply it opens", async () => {
    const llm = startFakeLlm([{ text: "First answer." }, { text: "Other side ready." }, { text: "Got PINEAPPLE, thanks." }]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
    const a = new AgentSession({ workspaceDir: ws, model });
    const b = new AgentSession({ workspaceDir: ws, model });
    await a.start();
    await b.start();
    await a.submit("hello");
    await until(() => !a.state.busy && !!a.sessionId);
    await b.submit("hi");
    await until(() => !b.state.busy && !!b.sessionId);
    const peers = await import("../src/lib/peers/peers");
    await until(() => peers.peerInboxRunning());
    const target = peers.resolvePeer(a.sessionId!, b.sessionId!);
    if ("error" in target) throw new Error(target.error);
    const sent = await peers.sendPeerMessage(
      target.row,
      { sessionId: b.sessionId!, name: "B", surface: "cli", workspace: ws },
      "PINEAPPLE",
    );
    expect(sent.ok).toBe(true);
    const texts = () => (a.state.cells as any[]).map((c) => `${c.kind}:${c.text ?? ""}`).join("\n");
    await until(() => texts().includes("Got PINEAPPLE, thanks."), 20_000);
    expect(texts()).toContain("PINEAPPLE");
    expect(texts()).toContain("Got PINEAPPLE, thanks.");
    llm.stop();
  }, 60_000);
});
