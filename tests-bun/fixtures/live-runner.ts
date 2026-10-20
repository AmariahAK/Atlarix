/**
 * Process A for live-sessions.test.ts: an Atlarix CLI session in its own
 * process, running turns of a session another process (the test) follows.
 *
 *   bun run --preload ./tests-bun/preload.ts tests-bun/fixtures/live-runner.ts <userData> <workspace> <llmUrl>
 *
 * Reads lines on stdin: `submit <text>` sends a message. Writes lines on stdout:
 * `SESSION <id>` once the session exists, `IDLE` when a turn ends.
 */
const [userData, workspace, llmUrl] = process.argv.slice(2) as [string, string, string];
process.env.ATLARIX_USER_DATA_DIR = userData;
process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
process.env.ATLARIX_SURFACE = "cli";
process.on("unhandledRejection", () => {});

const { AgentSession, seedDevProvider } = await import("../../src/cli/agent/session");
const s = new AgentSession({
  workspaceDir: workspace,
  model: await seedDevProvider({ baseUrl: llmUrl, model: "fake-model", apiKey: "dev" }),
});
await s.start();

let wasBusy = false;
let announced = false;
s.on("change", (st: { busy: boolean; approvals: Array<{ operationId: string }> }) => {
  for (const a of st.approvals) void s.answerApproval(a.operationId, "once").catch(() => {});
  if (!announced && s.sessionId) {
    announced = true;
    console.log(`SESSION ${s.sessionId}`);
  }
  if (wasBusy && !st.busy) console.log("IDLE");
  wasBusy = st.busy;
});

let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk.toString();
  for (let i = buffered.indexOf("\n"); i !== -1; i = buffered.indexOf("\n")) {
    const line = buffered.slice(0, i);
    buffered = buffered.slice(i + 1);
    if (line.startsWith("submit ")) void s.submit(line.slice(7));
  }
});
process.stdin.on("end", () => process.exit(0));
