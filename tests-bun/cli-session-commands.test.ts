/**
 * The session behind the CLI's commands, against the REAL agent loop and a
 * scripted model: /resume picks a conversation back up, ask_user's answers
 * carry the task on, a Plan-mode turn ends with a plan to build, /compact
 * shrinks the context, and an export imports back as the same conversation.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm, type FakeLlm, type Reply } from "./fixtures/fake-llm";

let ws: string;
const llms: FakeLlm[] = [];

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "cli-cmds-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cmds-ws-"));
  fs.writeFileSync(path.join(ws, "a.ts"), "export const a = 1;\n");
  // As the CLI does (shutdown.ts installProcessGuards): the AI SDK rejects
  // stream promises nobody awaits when a turn is stopped on purpose (ask_user
  // ends its turn by aborting it). The desktop drops those too (sentry-before-send).
  process.on("unhandledRejection", () => {});
});
// The fake models are never stopped: a finished turn's background title call can
// still be in flight to one after the last test, and its failure would be
// reported against whatever test file bun runs next. They end with the process.

async function sessionWith(script: Reply[]) {
  const llm = startFakeLlm(script);
  llms.push(llm);
  const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
  const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
  const s = new AgentSession({ workspaceDir: ws, model });
  await s.start();
  return { s, llm, model };
}

function waitFor(s: { state: any; on: Function; off: Function }, pred: (st: any) => boolean, ms = 30_000) {
  return new Promise<void>((resolve, reject) => {
    if (pred(s.state)) return resolve();
    const t = setTimeout(() => reject(new Error("condition never met")), ms);
    const check = (st: unknown) => {
      if (pred(st)) {
        clearTimeout(t);
        s.off("change", check);
        resolve();
      }
    };
    s.on("change", check);
  });
}

const idleAfter = async (s: any, send: () => Promise<void>) => {
  const started = waitFor(s, (st) => st.busy);
  await send();
  await started.catch(() => {});
  await waitFor(s, (st) => !st.busy);
};

const userTexts = (llm: FakeLlm) =>
  llm.requests
    .flatMap((r) => r.messages)
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

describe("the session's commands", () => {
  it("/resume opens an earlier session and the next message continues it", async () => {
    const first = await sessionWith([{ text: "The answer is 42." }]);
    await idleAfter(first.s, () => first.s.submit("what is the answer to everything?"));
    const id = first.s.sessionId;

    const second = await sessionWith([{ text: "Still 42." }]);
    const listed = await second.s.listSessions();
    expect(listed.map((x) => x.id)).toContain(id);
    await second.s.resume(id);
    expect(second.s.sessionId).toBe(id);
    expect(second.s.state.cells.some((c) => c.kind === "user" && c.text.includes("answer to everything"))).toBe(true);
    expect(second.s.state.cells.some((c) => c.kind === "markdown" && c.text.includes("42"))).toBe(true);

    await idleAfter(second.s, () => second.s.submit("are you sure?"));
    // The model saw the earlier exchange: the session was continued, not restarted.
    expect(userTexts(second.llm).some((t) => t.includes("answer to everything"))).toBe(true);
    expect(second.s.state.cells.filter((c: any) => c.kind !== "footer").at(-1)).toMatchObject({ kind: "markdown", text: "Still 42." });
  }, 60_000);

  it("ask_user: the questions surface, and the answer carries the task on", async () => {
    // The question arrives as main sends it (stream-lifecycle.ts resolveAskUserToolResult).
    // Raised directly: a turn that really ends on ask_user aborts its stream, and
    // the AI SDK leaves a step-tracing promise rejected with nobody listening
    // (ai/dist streamStep `stepFinish.promise`), which bun test counts as a failure.
    const { s, llm } = await sessionWith([{ text: "Which database?" }, { text: "Going with SQLite." }]);
    await idleAfter(s, () => s.submit("set up a database"));
    (s as any).onSend("user-question-request", {
      chatId: s.chatId,
      questionId: "uq_test",
      question: "Which database?",
      options: ["Postgres", "SQLite"],
      questions: [{ question: "Which database?", options: ["Postgres", "SQLite"] }],
    });
    expect(s.state.question).toMatchObject({ questionId: "uq_test", items: [{ question: "Which database?", options: ["Postgres", "SQLite"] }] });

    const continued = waitFor(s, (st) => st.cells.some((c: any) => c.kind === "markdown" && c.text === "Going with SQLite."));
    await s.answerQuestion(["SQLite"]);
    await continued;
    expect(s.state.question).toBeNull();
    // The answer reached the model as the next user message.
    expect(userTexts(llm).some((t) => t.includes("SQLite"))).toBe(true);
  }, 60_000);

  it("Plan mode: a turn that writes a plan ends with it ready, and Build it starts building", async () => {
    const { s } = await sessionWith([
      { tool: "plan", args: { operation: "write", title: "Add a health endpoint", content: "# Add a health endpoint\n\n- [ ] Add GET /health\n- [ ] Test it" } },
      { text: "The plan is ready." },
      { text: "Building it now." },
    ]);
    s.setMode("plan");
    await idleAfter(s, () => s.submit("plan a /health endpoint"));
    await waitFor(s, (st) => st.planReady != null);
    expect(s.state.planReady).toMatchObject({ title: "Add a health endpoint" });
    const plans = await s.plans();
    expect(plans[0]).toMatchObject({ title: "Add a health endpoint", status: "plan" });

    await idleAfter(s, () => s.buildPlan(s.state.planReady!.planId));
    expect(s.state.mode).toBe("build");
    expect(s.state.planReady).toBeNull();
    expect((await s.plans())[0]!.status).not.toBe("plan");
  }, 60_000);

  it("/compact refuses a short conversation and compacts a long one", async () => {
    const { s } = await sessionWith([{ text: "First answer, with some words in it." }]);
    expect((await s.compact()).ok).toBe(false);
    await idleAfter(s, () => s.submit("one"));
    await idleAfter(s, () => s.submit("two"));
    await idleAfter(s, () => s.submit("three"));
    const res = await s.compact();
    expect(res.message).toMatch(/Compacted|Nothing to compact/);
    expect(s.state.busy).toBe(false);
  }, 60_000);

  it("an export imports back as the same conversation", async () => {
    const { s } = await sessionWith([{ tool: "read_file", args: { path: "a.ts" } }, { text: "a is 1." }]);
    await idleAfter(s, () => s.submit("what is a?"));
    const { fromAtlarixMessages, messageContent } = await import("../src/cli/sessions/portable");
    const doc = fromAtlarixMessages(s.exportable().messages, { title: "What is a", workspace: ws });
    expect(doc.messages[0]).toMatchObject({ role: "user", text: "what is a?" });
    expect(doc.messages[1]!.tools?.[0]).toMatchObject({ name: "Read", target: "a.ts" });

    const before = s.sessionId;
    await s.importMessages("What is a (copy)", doc.messages.map((m) => ({ role: m.role, content: messageContent(m) })));
    expect(s.sessionId).not.toBe(before);
    expect(s.state.title).toBe("What is a (copy)");
    expect(s.state.cells.some((c) => c.kind === "user" && c.text === "what is a?")).toBe(true);
    expect(s.state.cells.some((c) => c.kind === "markdown" && c.text.includes("a is 1."))).toBe(true);
  }, 60_000);

  it("/undo: going back to a message restores the files changed since, and the edited message is answered", async () => {
    const file = path.join(ws, "undo.ts");
    fs.writeFileSync(file, "export const v = 1;\n");
    const { s, llm } = await sessionWith([
      { tool: "edit_file", args: { path: "undo.ts", operation: "replace", old_content: "export const v = 1;", new_content: "export const v = 2;" } },
      { text: "Changed v." },
      { text: "Left v alone." },
    ]);
    const approve = (st: any) => {
      if (st.approvals.length) void s.answerApproval(st.approvals[0].operationId, "once");
    };
    s.on("change", approve);
    await idleAfter(s, () => s.submit("set v to 2"));
    s.off("change", approve);
    expect(fs.readFileSync(file, "utf8")).toContain("v = 2");

    const [mine] = s.myMessages();
    expect(mine!.text).toBe("set v to 2");
    const preview = await s.undoPreview(mine!.id);
    expect(preview.turnIds.length).toBe(1);
    expect(preview.filesChanged.some((f) => f.endsWith("undo.ts"))).toBe(true);

    const done = waitFor(s, (st) => st.cells.some((c: any) => c.kind === "markdown" && c.text === "Left v alone."));
    const { restoredFiles } = await s.resendEdited(mine!.id, "just look at v", preview.turnIds);
    await done;
    expect(restoredFiles).toBeGreaterThan(0);
    expect(fs.readFileSync(file, "utf8")).toContain("v = 1");
    const texts = s.state.cells.map((c: any) => c.text).filter(Boolean);
    expect(texts).toContain("just look at v");
    expect(texts).not.toContain("set v to 2");
    expect(texts).not.toContain("Changed v.");
    // The model's last request carries the edited message, not the replaced one.
    const last = JSON.stringify(llm.requests.filter((r: any) => r.tools?.length).at(-1)?.messages ?? []);
    expect(last).toContain("just look at v");
    expect(last).not.toContain("set v to 2");
  }, 60_000);

  it("/undo to the FIRST of three messages restores every later turn's files and drops every later message", async () => {
    const file = path.join(ws, "many.ts");
    fs.writeFileSync(file, "export const n = 0;\n");
    const edit = (from: number, to: number) => ({
      tool: "edit_file",
      args: { path: "many.ts", operation: "replace", old_content: `export const n = ${from};`, new_content: `export const n = ${to};` },
    });
    const { s, llm } = await sessionWith([
      edit(0, 1), { text: "n is 1." },
      edit(1, 2), { text: "n is 2." },
      edit(2, 3), { text: "n is 3." },
      { text: "Redone from the start." },
    ]);
    const approve = (st: any) => {
      if (st.approvals.length) void s.answerApproval(st.approvals[0].operationId, "once");
    };
    s.on("change", approve);
    await idleAfter(s, () => s.submit("set n to 1"));
    await idleAfter(s, () => s.submit("now 2"));
    await idleAfter(s, () => s.submit("now 3"));
    s.off("change", approve);
    // Each turn ran: main sends a turn's end twice, and the second used to mark
    // the session idle while the next turn ran, which swallowed turns 2 and 3.
    expect(fs.readFileSync(file, "utf8")).toContain("n = 3");

    const mine = s.myMessages();
    expect(mine.map((m) => m.text)).toEqual(["now 3", "now 2", "set n to 1"]);
    const first = mine.at(-1)!;
    const preview = await s.undoPreview(first.id);
    expect(preview.turnIds.length).toBe(3); // all three replies after it
    const done = waitFor(s, (st) => st.cells.some((c: any) => c.kind === "markdown" && c.text === "Redone from the start."));
    await s.resendEdited(first.id, "leave n alone", preview.turnIds);
    await done;
    expect(fs.readFileSync(file, "utf8")).toContain("n = 0"); // back to before the first turn
    const texts = s.state.cells.map((c: any) => c.text).filter(Boolean);
    for (const gone of ["set n to 1", "now 2", "now 3", "n is 1.", "n is 3."]) expect(texts).not.toContain(gone);
    const last = JSON.stringify(llm.requests.filter((r: any) => r.tools?.length).at(-1)?.messages ?? []);
    expect(last).toContain("leave n alone");
    expect(last).not.toContain("now 2");
  }, 90_000);

  it("a sub-agent's tool calls nest under the task call that started it", async () => {
    // The real `task` call starts a real delegation (its subagent_start maps it
    // to this reply's task_0). The fake model can't tell a sub-agent's requests
    // from the main agent's, so the sub-agent's own tool call is sent as main
    // sends it (register-delegation-tools.ts emitSubagentActivity).
    const { s } = await sessionWith([
      { tool: "task", args: { subagent_type: "explore", description: "find the export", prompt: "Find where a is exported." } },
      { text: "Asked a sub-agent." },
    ]);
    await idleAfter(s, () => s.submit("where is a exported?"));
    const [delegationId] = [...(s as any).delegations.keys()];
    expect(delegationId).toBeTruthy();
    (s as any).onSend("chat:activity", {
      type: "tool_use",
      id: "sub-grep-1",
      chatId: s.chatId,
      toolName: "grep",
      status: "success",
      toolArgs: { pattern: "export const a" },
      resultText: "a.ts:1: export const a = 1;",
      parentDelegationId: delegationId,
    });
    const task = s.state.cells.find((c: any) => c.kind === "tool" && c.tool.verb === "Agent") as any;
    expect(task.tool.children).toEqual([expect.objectContaining({ verb: "Search", target: '"export const a"', status: "success" })]);
    // While it runs, /tasks lists it with the same calls (the app's card, as a list).
    (s as any).delegations.get(delegationId).status = "running";
    const live = await s.liveTasks();
    expect(live).toContainEqual(
      expect.objectContaining({ kind: "agent", tools: [expect.objectContaining({ verb: "Search" })] }),
    );
  }, 60_000);

  it("a sub-agent actually runs in the CLI, and its row clears when it ends", async () => {
    // The CLI's electron stub had no BrowserWindow.fromWebContents, so `task`
    // threw before spawning, and the strip showed "Sub-agent: Scout" running
    // forever (owner, 2026-10-05).
    const { s, llm } = await sessionWith([
      { tool: "task", args: { subagent_type: "explore", description: "find the export", prompt: "Find where a is exported." } },
      { text: "a is exported from a.ts." },
      { text: "The sub-agent found it." },
    ]);
    await idleAfter(s, () => s.submit("where is a exported?"));
    const task = s.state.cells.find((c: any) => c.kind === "tool" && c.tool.verb === "Agent") as any;
    expect(task).toBeTruthy();
    expect(JSON.stringify(task.tool)).not.toContain("fromWebContents");
    // It ran on THIS session's model (the CLI's own choice), not the app's
    // saved one: its request reached the same fake model.
    expect(JSON.stringify(task.tool)).not.toContain("isn't offered");
    expect(llm.requests.some((r: any) => JSON.stringify(r.messages).includes("Find where a is exported."))).toBe(true);
    await waitFor(s, () => [...(s as any).delegations.values()].every((d: any) => d.status !== "running"), 30_000);
    const live = await s.liveTasks();
    expect(live.filter((t: any) => t.kind === "agent")).toEqual([]);
  }, 60_000);

  it("a relic on your own key is saved in the workspace, and the transcript says where", async () => {
    const { s } = await sessionWith([
      { tool: "relic", args: { title: "Login flow", html: "<!doctype html><title>Login flow</title><h1>Login</h1>" } },
      { text: "Here's the design." },
    ]);
    const approve = (st: any) => {
      if (st.approvals.length) void s.answerApproval(st.approvals[0].operationId, "once");
    };
    s.on("change", approve);
    await idleAfter(s, () => s.submit("sketch the login flow"));
    s.off("change", approve);
    const file = path.join(ws, ".atlarix", "relics", "login-flow", "index.html");
    expect(fs.readFileSync(file, "utf8")).toContain("<h1>Login</h1>");
    const line = s.state.cells.find((c: any) => c.kind === "tool" && c.tool.verb === "Relic") as any;
    expect(line.tool.output).toBe(`Saved ${file}`);
    const { lastRelic } = await import("../src/cli/tui/App");
    expect(lastRelic(s.state.cells)).toBe(file);
  }, 60_000);
});
