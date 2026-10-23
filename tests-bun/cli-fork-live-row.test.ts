/**
 * ai-44 A2: after /fork the CLI shows the copy, but the ORIGINAL kept its live
 * row under this process. list_sessions offered it, send_message to it said
 * "Sent … it starts a turn", and the message went to a chat nobody showed.
 * Switching sessions (/fork, /resume, /new) must leave the list with only what
 * this process can actually be reached at.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm, type FakeLlm, type Reply } from "./fixtures/fake-llm";

let ws: string;
const llms: FakeLlm[] = [];

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "cli-fork-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-fork-ws-"));
  process.chdir(ws);
  process.on("unhandledRejection", () => {});
});

async function sessionWith(script: Reply[]) {
  const llm = startFakeLlm(script);
  llms.push(llm);
  await import("../src/headless/bundled-assets");
  const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
  const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
  const s = new AgentSession({ workspaceDir: ws, model });
  await s.start();
  return s;
}

function idle(s: any): Promise<void> {
  return new Promise((resolve) => {
    if (!s.state.busy) return resolve();
    const check = (st: any) => {
      if (!st.busy) {
        s.off("change", check);
        resolve();
      }
    };
    s.on("change", check);
  });
}

async function send(s: any, text: string) {
  const started = new Promise<void>((r) => {
    const on = (st: any) => {
      if (st.busy) {
        s.off("change", on);
        r();
      }
    };
    s.on("change", on);
  });
  await s.submit(text);
  await Promise.race([started, new Promise((r) => setTimeout(r, 2000))]);
  await idle(s);
}

const settle = () => new Promise((r) => setTimeout(r, 300));

describe("a CLI that switches sessions leaves only the one it shows", () => {
  it("/fork: the original's row goes, the fork's is there", async () => {
    const { localSessionIds } = await import("../src/lib/peers/peers");
    const s = await sessionWith([{ text: "Hello." }]);
    await send(s, "hi");
    const original = s.sessionId;
    await settle();
    expect(localSessionIds()).toContain(original);

    const fork = await s.fork("forked-b");
    await settle();
    expect(s.sessionId).toBe(fork.id);
    expect(localSessionIds()).toContain(fork.id);
    expect(localSessionIds()).not.toContain(original);
  }, 60_000);

  it("/new: the session left is not reachable here either", async () => {
    const { localSessionIds } = await import("../src/lib/peers/peers");
    const s = await sessionWith([{ text: "Hi again." }]);
    await send(s, "hello");
    const left = s.sessionId;
    await settle();
    await s.newSession();
    await settle();
    expect(localSessionIds()).not.toContain(left);
  }, 60_000);
});
