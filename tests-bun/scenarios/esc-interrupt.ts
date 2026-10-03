/**
 * Esc during a long command, end to end with the real agent loop and the CLI's
 * own process guards. Prints one `RESULT {json}` line for cli-session.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "../fixtures/fake-llm";

process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "esc-ud-"));
process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "esc-ws-"));

const { installProcessGuards } = await import("../../src/cli/shutdown");
installProcessGuards();
const llm = startFakeLlm([
  { tool: "run_command", args: { command: "sleep 37.25", description: "wait a while" } },
  { text: "Next turn works." },
]);
const { AgentSession, seedDevProvider } = await import("../../src/cli/agent/session");
const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
await s.start();

const waitFor = (pred: (st: typeof s.state) => boolean, ms = 30_000) =>
  new Promise<void>((resolve, reject) => {
    if (pred(s.state)) return resolve();
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    const on = (st: typeof s.state) => {
      if (pred(st)) {
        clearTimeout(t);
        s.off("change", on);
        resolve();
      }
    };
    s.on("change", on);
  });

const running = () => Bun.spawnSync(["pgrep", "-f", "sleep 37.25"]).stdout.toString().trim() !== "";
await s.submit("wait");
await waitFor((st) => st.approvals.length > 0 || st.cells.some((c) => c.kind === "tool" && c.tool.status === "running"));
if (s.state.approvals.length) await s.answerApproval(s.state.approvals[0]!.operationId, "once");
await Bun.sleep(800);
const wasRunning = running();
const t0 = Date.now();
await s.interrupt();
await waitFor((st) => !st.busy, 10_000);
const stoppedWithinMs = Date.now() - t0;
await Bun.sleep(500);
const result = {
  wasRunning,
  stoppedWithinMs,
  lastError: s.state.lastError,
  toolInterrupted: s.state.cells.some((c) => c.kind === "tool" && c.tool.status === "interrupted"),
  noticeShown: s.state.cells.some((c) => c.kind === "notice" && /Interrupted/.test(c.text)),
  processGone: !running(),
  nextTurnWorked: false,
};
await s.submit("carry on");
await waitFor((st) => !st.busy && st.cells.some((c) => c.kind === "markdown" && c.text === "Next turn works."), 30_000).then(
  () => (result.nextTurnWorked = true),
  () => {},
);
if (process.env.DUMP) {
  console.log("MESSAGES " + JSON.stringify((s as unknown as { messages: Array<{ id: unknown; role: string; content: string }> }).messages.map((m) => [m.id, m.role, m.content.slice(0, 160)])));
  console.log("CELLS " + JSON.stringify(s.state.cells.map((c) => [c.id, c.kind, c.kind === "tool" ? c.tool.status : (c as { text?: string }).text?.slice(0, 50)])));
}
// No ghost of the stopped turn after the next one (#19).
Object.assign(result, {
  oneToolCell: s.state.cells.filter((c) => c.kind === "tool").length === 1,
  toolStillInterrupted: s.state.cells.some((c) => c.kind === "tool" && c.tool.status === "interrupted"),
  noCancelText: !s.state.cells.some((c) => "text" in c && c.text.includes("Response cancelled")),
});
console.log("RESULT " + JSON.stringify(result));
llm.stop();
process.exit(0);
