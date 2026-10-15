/**
 * Without Git, Revert is off and the chat says so once (QA 15.7.1 #3). The
 * notice arrives as a background chat:activity; the CLI (and ACP/VS Code, which
 * run this session) dropped every chat:activity that wasn't a sub-agent's.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "nogit-ud-"),
  );
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-ws-"));
});

type Cell = { kind: string; text?: string };
const notice = {
  id: "revert-needs-git",
  type: "background",
  label: "Revert is off: Git isn't installed.",
  status: "done",
};

describe("Revert is off without Git", () => {
  it("shows once, in this chat only", async () => {
    const { AgentSession, seedDevProvider } = await import(
      "../src/cli/agent/session"
    );
    const model = await seedDevProvider({
      baseUrl: "http://127.0.0.1:9/v1",
      model: "fake-model",
      apiKey: "dev",
    });
    const s = new AgentSession({ workspaceDir: ws, model });
    const raw = s as unknown as {
      chatId: number;
      onSend(channel: string, payload: unknown): void;
      state: { cells: Cell[] };
    };
    raw.chatId = 5;
    const lines = () =>
      raw.state.cells.filter(
        (c) => c.kind === "notice" && c.text === notice.label,
      );

    raw.onSend("chat:activity", { ...notice, chatId: 6 });
    expect(lines()).toHaveLength(0);

    raw.onSend("chat:activity", { ...notice, chatId: 5 });
    raw.onSend("chat:activity", { ...notice, chatId: 5 });
    expect(lines()).toHaveLength(1);
  }, 30_000);
});
