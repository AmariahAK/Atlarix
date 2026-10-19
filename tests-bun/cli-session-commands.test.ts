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
  // Run where a user runs it: in THEIR repository, not this one. Bundled files
  // read from `<cwd>/src/…` only ever worked from here (owner, 2026-10-05: every
  // sub-agent in ruff failed on src/skills/subagents/subagent.md).
  process.chdir(ws);
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
  await import("../src/headless/bundled-assets"); // as src/cli/entry.mts does, first
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

  // Owner: no random reverts. A real turn records how it left its files; a
  // restore keeps a file changed after that and says so.
  it("restoring files keeps a file someone changed after the turn, and names it", async () => {
    const file = path.join(ws, "keep.ts");
    const other = path.join(ws, "goes-back.ts");
    fs.writeFileSync(file, "export const k = 1;\n");
    fs.writeFileSync(other, "export const g = 1;\n");
    const { s } = await sessionWith([
      { tool: "edit_file", args: { path: "keep.ts", operation: "replace", old_content: "export const k = 1;", new_content: "export const k = 2;" } },
      { tool: "edit_file", args: { path: "goes-back.ts", operation: "replace", old_content: "export const g = 1;", new_content: "export const g = 2;" } },
      { text: "Changed both." },
    ]);
    const approve = (st: any) => {
      if (st.approvals.length) void s.answerApproval(st.approvals[0].operationId, "once");
    };
    s.on("change", approve);
    await idleAfter(s, () => s.submit("set k and g to 2"));
    s.off("change", approve);
    // A teammate (or the user) edits one of them after the turn.
    fs.writeFileSync(file, "export const k = 2; // teammate\n");

    const [mine] = s.myMessages();
    // The dialog before says the same as the result after (nothing written yet).
    const preview = await s.undoPreview(mine!.id);
    expect(preview.kept.some((f) => f.endsWith("keep.ts"))).toBe(true);
    expect(preview.kept.some((f) => f.endsWith("goes-back.ts"))).toBe(false);
    expect(fs.readFileSync(other, "utf8")).toContain("g = 2");
    const { kept } = await s.restoreFilesSince(mine!.id);
    expect(fs.readFileSync(file, "utf8")).toContain("// teammate");
    expect(fs.readFileSync(other, "utf8")).toContain("g = 1");
    expect(kept.some((f) => f.endsWith("keep.ts"))).toBe(true);
    // The agent is told only about the file that went back.
    expect((s as any).restoredNote).toContain("goes-back.ts");
    expect((s as any).restoredNote).not.toContain("keep.ts");
  }, 60_000);

  // The commonest revert: stop a turn that went wrong, then put its files back.
  // A stopped turn never reached the turn's end, so it was unchecked.
  it("a STOPPED turn's restore also keeps a file changed after it", async () => {
    const file = path.join(ws, "stopped.ts");
    fs.writeFileSync(file, "export const t = 1;\n");
    const { s } = await sessionWith([
      { tool: "edit_file", args: { path: "stopped.ts", operation: "replace", old_content: "export const t = 1;", new_content: "export const t = 2;" } },
      { text: "Still going, slowly, word by word, until the user stops me.", delayMs: 400 },
    ]);
    const approve = (st: any) => {
      if (st.approvals.length) void s.answerApproval(st.approvals[0].operationId, "once");
    };
    s.on("change", approve);
    await idleAfter(s, async () => {
      void s.submit("set t to 2");
      while (!fs.readFileSync(file, "utf8").includes("t = 2")) await Bun.sleep(20);
      await Bun.sleep(100);
      await s.interrupt();
    });
    s.off("change", approve);
    fs.writeFileSync(file, "export const t = 2; // the user's fix\n");

    const [mine] = s.myMessages();
    const { kept } = await s.restoreFilesSince(mine!.id);
    expect(fs.readFileSync(file, "utf8")).toContain("// the user's fix");
    expect(kept.some((f) => f.endsWith("stopped.ts"))).toBe(true);
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
    // A new first message is a new title (owner, 2026-10-19), as in the app.
    // (No title model here: the title is made from the words.)
    await waitFor(s, (st) => /leave n alone/i.test(st.title ?? ""), 10_000);
    expect(s.state.title).not.toMatch(/set n to 1/i);
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
    expect(JSON.stringify(task.tool)).not.toContain("ENOENT");
    // The turn carried its mode prompt, which was silently dropped outside this repo.
    expect(JSON.stringify(llm.requests[0])).toContain("[Active Skill: modes/");
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

  // The desktop showed nothing to say which automation woke a reply (the CLI
  // and editor note it themselves). The wake turn's stream now sends it as a
  // "background" line, which the app's thread draws; the CLI ignores it.
  it("a wake turn names the automation that woke it", async () => {
    const { s, llm } = await sessionWith([{ text: "Hello." }, { text: "Looking at the failures." }]);
    await idleAfter(s, () => s.submit("hi"));
    const sent: Array<{ channel: string; p: any }> = [];
    const onSend = (s as any).onSend.bind(s);
    (s as any).onSend = (channel: string, p: any) => {
      sent.push({ channel, p });
      onSend(channel, p);
    };
    const { recordAutomationResult } = await import("../src/lib/agent/automation-results");
    recordAutomationResult((s as any).appId, {
      automationId: "a1",
      automationName: "Nightly CI",
      status: "ok",
      body: "2 failing checks on main",
      finishedAt: Date.now(),
    });
    await idleAfter(s, async () => {
      (s as any).onSend("chat:background-job-update", { chatId: s.chatId, source: "automation", status: "finished" });
    });
    expect(JSON.stringify(llm.requests.at(-1))).toContain("2 failing checks on main");
    const lines = sent.filter((x) => x.channel === "chat:activity" && x.p.type === "background").map((x) => x.p.label);
    expect(lines).toEqual(['Automation "Nightly CI" finished: 2 failing checks on main']);
  }, 60_000);

  // App QA #1 (2026-10-14): a turn stopped while it waited, then a teammate's
  // message to the chat reopened from disk. The stopped turn's saved row had no
  // stop note, and the next turn overwrote and then deleted it, so the model saw
  // the request unanswered and re-ran it instead of answering.
  it("a turn stopped mid-wait stays saved as stopped, and a reopened chat's model is told", async () => {
    const { s } = await sessionWith([
      { tool: "edit_file", args: { path: "w.ts", operation: "replace", old_content: "export const a = 1;", new_content: "export const a = 9;" } },
    ]);
    fs.writeFileSync(path.join(ws, "w.ts"), "export const a = 1;\n");
    await idleAfter(s, async () => {
      void s.submit("set a to 9");
      while (!s.state.approvals.length) await Bun.sleep(20); // waiting on the user
      await s.interrupt();
    });
    const second = await sessionWith([{ text: "Got it." }]);
    await second.s.resume(s.sessionId);
    await idleAfter(second.s, () => second.s.submit("reply got it"));
    const sent = (second.llm.requests.at(-1)?.messages ?? []).filter((m: any) => m.role !== "system");
    const i = sent.findIndex((m: any) => m.role === "user" && m.content === "set a to 9");
    expect(sent[i + 1]?.role).toBe("assistant");
    expect(JSON.stringify(sent[i + 1])).toContain("[Response cancelled by user]");
    // The stopped turn's row is still there after the next turn completed.
    const { getDb } = await import("../src/db");
    const rows = (getDb().$client as any)
      .prepare("select role, status from session_messages where session_id = ? order by created_at")
      .all(s.sessionId);
    expect(rows.map((r: any) => `${r.role}:${r.status}`)).toEqual([
      "user:complete",
      "assistant:interrupted",
      "user:complete",
      "assistant:complete",
    ]);
  }, 60_000);

  // The same in Ask (implementer's review of the fix above): Ask has its own
  // branch, which saved nothing on a stop, and its draft row was deleted by
  // the next turn.
  it("an Ask turn that was stopped is still there, marked stopped, after another turn and a reopen", async () => {
    const { s } = await sessionWith([
      { text: "Looking at it now, slowly, word by word, until the user stops me.", delayMs: 400 },
      { text: "Sure." },
    ]);
    s.setMode("ask");
    await idleAfter(s, async () => {
      void s.submit("explain the build");
      while (!s.state.cells.some((c: any) => c.kind === "markdown" && c.text.includes("Looking"))) await Bun.sleep(20);
      await s.interrupt();
    });
    await idleAfter(s, () => s.submit("never mind, say sure"));
    const second = await sessionWith([{ text: "Got it." }]);
    await second.s.resume(s.sessionId);
    await idleAfter(second.s, () => second.s.submit("reply got it"));
    const sent = (second.llm.requests.at(-1)?.messages ?? []).filter((m: any) => m.role !== "system");
    const i = sent.findIndex((m: any) => m.role === "user" && m.content === "explain the build");
    expect(sent[i + 1]?.role).toBe("assistant");
    expect(JSON.stringify(sent[i + 1])).toContain("Looking");
    expect(JSON.stringify(sent[i + 1])).toContain("[Response cancelled by user]");
  }, 60_000);
});
