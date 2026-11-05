/**
 * One session reviews another's pending permission request end to end (0aa):
 * the real tools, the real permission layer and the real inbox. The reviewer
 * reads what the request does (list_sessions pending_of) and answers it with
 * send_message: approve runs it; change refuses it and says what to do instead.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "peer-review-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "peer-review-ws-"));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 30_000): Promise<void> {
  for (let i = 0; i < ms / 100 && !pred(); i++) await wait(100);
  if (!pred()) throw new Error("condition never met");
}

type Result = { success: boolean; text?: string; error?: string };
const run = async (tool: string, args: Record<string, unknown>): Promise<Result> => {
  const { ToolRegistry } = await import("../src/lib/tools/registry");
  await import("../src/lib/tools/peers");
  let raw = (await ToolRegistry.execute(tool, args)) as unknown;
  while (raw && typeof raw === "object" && "result" in raw && typeof (raw as { result: unknown }).result === "object") {
    raw = (raw as { result: unknown }).result;
  }
  return raw as Result;
};

async function pair(script: Parameters<typeof startFakeLlm>[0]) {
  const llm = startFakeLlm(script);
  const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
  const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
  const reviewer = new AgentSession({ workspaceDir: ws, model });
  const asker = new AgentSession({ workspaceDir: ws, model });
  await reviewer.start();
  await asker.start();
  await reviewer.submit("hi");
  await until(() => !reviewer.state.busy && !!reviewer.sessionId);
  const { peerInboxRunning } = await import("../src/lib/peers/peers");
  await until(() => peerInboxRunning());
  return { llm, reviewer, asker };
}

describe("a session reviews another's pending request", () => {
  it("reads the change it asks to make, with its content, approves it, and the file is written", async () => {
    const { llm, reviewer, asker } = await pair([
      { text: "Ready." },
      { tool: "edit_file", args: { path: "made.ts", operation: "write", content: "export const made = 42;\n" } },
      { text: "Made." },
    ]);
    await asker.submit("make the file");
    await until(() => asker.state.approvals.length > 0);
    await asker.rename("Builder");
    const op = asker.state.approvals[0]!.operationId;

    const seen = await run("list_sessions", { workspaceSessionId: reviewer.sessionId, pending_of: "Builder" });
    expect(seen.text).toContain(op);
    expect(seen.text).toContain("made.ts");
    // The change itself, not only its path.
    expect(seen.text).toContain("export const made = 42;");

    const answered = await run("send_message", { to: "Builder", approval: op, workspaceSessionId: reviewer.sessionId });
    expect(answered.success).toBe(true);
    await until(() => !asker.state.busy);
    expect(fs.readFileSync(path.join(ws, "made.ts"), "utf8")).toBe("export const made = 42;\n");
    // Answered there: the card is gone from the asker's screen.
    expect(asker.state.approvals).toEqual([]);
    llm.stop();
  }, 90_000);

  it("change: the request is refused and the asker reads what to do instead", async () => {
    fs.writeFileSync(path.join(ws, "doomed.txt"), "keep me");
    const { llm, reviewer, asker } = await pair([
      { text: "Ready." },
      { tool: "run_command", args: { command: "rm doomed.txt", description: "remove the file" } },
      { text: "Kept it." },
    ]);
    await asker.submit("delete doomed.txt");
    await until(() => asker.state.approvals.length > 0);
    await asker.rename("Cleaner");
    const op = asker.state.approvals[0]!.operationId;

    const noMessage = await run("send_message", { to: "Cleaner", approval: op, approval_mode: "change", workspaceSessionId: reviewer.sessionId });
    expect(noMessage.success).toBe(false);

    const answered = await run("send_message", {
      to: "Cleaner",
      approval: op,
      approval_mode: "change",
      message: "Don't delete it: move it to archive/ instead.",
      workspaceSessionId: reviewer.sessionId,
    });
    expect(answered.success).toBe(true);
    await until(() => !asker.state.busy);
    expect(fs.existsSync(path.join(ws, "doomed.txt"))).toBe(true);
    // The asker's next model call carries the reviewer's instruction.
    expect(JSON.stringify(llm.requests.at(-1)?.messages ?? [])).toContain("move it to archive/ instead");
    llm.stop();
  }, 90_000);

  it("a request that is not pending is refused, not guessed at", async () => {
    const { llm, reviewer, asker } = await pair([{ text: "Ready." }, { text: "Nothing to do." }]);
    await asker.submit("hello");
    await until(() => !asker.state.busy && !!asker.sessionId);
    await asker.rename("Idle one");
    const r = await run("send_message", { to: "Idle one", approval: "op-not-real", workspaceSessionId: reviewer.sessionId });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("no pending request op-not-real");
    llm.stop();
  }, 90_000);
});
