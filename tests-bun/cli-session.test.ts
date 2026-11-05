/**
 * The CLI's session controller against the REAL agent loop and a scripted fake
 * model: a turn runs, tool lines and prose arrive as cells, and a message sent
 * with Tab while the turn runs opens the next turn.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm, type FakeLlm } from "./fixtures/fake-llm";

let llm: FakeLlm;
let ws: string;

beforeAll(() => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "cli-session-ud-"));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-session-ws-"));
  fs.writeFileSync(path.join(ws, "a.ts"), "// TODO: something\n");
  process.env.ATLARIX_USER_DATA_DIR = ud;
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  llm = startFakeLlm([
    { tool: "grep", args: { pattern: "TODO" } },
    { text: "Found one TODO in a.ts.", delayMs: 30 },
  ]);
});
// The fake model is never stopped: a finished turn's background title call can
// still be in flight to it, and that failure would be reported against the next
// test file bun runs. It ends with the process.

function waitIdle(s: { state: { busy: boolean }; on: Function; off: Function }, ms = 30_000) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("turn never finished")), ms);
    const check = (st: { busy: boolean }) => {
      if (!st.busy) {
        clearTimeout(t);
        s.off("change", check);
        resolve();
      }
    };
    s.on("change", check);
  });
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

describe("AgentSession", () => {
  it("names a Core model in the turn's footer by its model, not its slot id", async () => {
    const { AgentSession } = await import("../src/cli/agent/session");
    const { setCoreModelOverrides } = await import("../src/ipc/shared/core-model-override-store");
    setCoreModelOverrides({ "core-4": "z-ai/glm-5.3-flash" });
    const s = new AgentSession({ workspaceDir: ws, model: { provider: "compass", name: "core-4" } });
    const name = await (s as unknown as { footerModelName(): Promise<string | undefined> }).footerModelName();
    expect(name).toContain("5.3 Flash");
    expect(name).not.toBe("core-4");
  });

  it("runs a turn: a search line, then the answer", async () => {
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    const { db } = await import("../src/db");
    const schema = await import("../src/db/schema");
    const sessions = () => db.select().from(schema.chatSessions).all().length;
    const before = sessions();
    await s.start();
    // Opening the CLI adds nothing to the desktop's session list…
    expect(s.sessionId).toBe("");
    expect(sessions()).toBe(before);
    const done = waitIdle(s);
    await s.submit("find the TODOs");
    await done;
    // …the first message does.
    expect(s.sessionId).toBeTruthy();
    expect(sessions()).toBe(before + 1);
    const kinds = s.state.cells.map((c) => c.kind);
    expect(kinds[0]).toBe("user");
    expect(s.state.cells.some((c) => c.kind === "tool" && c.tool.verb === "Search")).toBe(true);
    expect(s.state.cells.filter((c: any) => c.kind !== "footer").at(-1)).toMatchObject({ kind: "markdown", text: "Found one TODO in a.ts." });
    expect(s.state.lastError).toBeNull();
  }, 60_000);

  it("Tab while a turn runs: held, shown as pending, then sent as the next turn", async () => {
    llm.stop();
    llm = startFakeLlm([
      { text: "First answer, streamed slowly so there is time to queue.", delayMs: 60 },
      { text: "Second answer." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    await s.submit("first");
    expect(s.state.busy).toBe(true);
    s.queueNext("then this");
    expect(s.state.pending).toEqual([{ id: expect.any(String), text: "then this", kind: "queued" }]);
    await waitFor(s, (st) => st.cells.some((c: any) => c.kind === "markdown" && c.text === "Second answer."));
    const users = s.state.cells.filter((c) => c.kind === "user").map((c: any) => c.text);
    expect(users).toEqual(["first", "then this"]);
    await waitFor(s, (st) => !st.busy && st.pending.length === 0);
  }, 60_000);

  it("alt+up pulls the last queued message back instead of sending it", async () => {
    llm.stop();
    llm = startFakeLlm([{ text: "Slow answer so the queue stays open for a moment.", delayMs: 60 }]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
    await s.start();
    await s.submit("go");
    s.queueNext("oops, edit me");
    expect(s.popLastQueued()).toBe("oops, edit me");
    expect(s.state.pending).toEqual([]);
    await waitFor(s, (st) => !st.busy);
    expect(s.state.cells.filter((c) => c.kind === "user").map((c: any) => c.text)).toEqual(["go"]);
  }, 60_000);

  it("an image sent while a turn runs is not dropped: it opens the next turn with the message (Tab or Enter)", async () => {
    const img = path.join(ws, "shot.png");
    // A 1×1 PNG: real bytes, so the turn can read and attach it.
    fs.writeFileSync(img, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const images = [{ path: img, mime: "image/png", label: "[Image #1]" }];
    const carried = (s: any) =>
      // Either the image reached the model, or a text-only model refused it by
      // name: both prove the image travelled with the message, not dropped.
      String(s.state.lastError ?? "").includes("can't see images") ||
      JSON.stringify(llm.requests.at(-1)?.messages ?? []).includes("image");
    for (const via of ["tab", "enter"] as const) {
      llm.stop();
      llm = startFakeLlm([
        { text: "Slow first answer so the second message arrives mid-turn.", delayMs: 60 },
        { text: "Saw it." },
      ]);
      const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
      const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
      await s.start();
      await s.submit("first");
      expect(s.state.busy).toBe(true);
      if (via === "tab") s.queueNext("what is in [Image #1]?", images);
      else await s.submit("what is in [Image #1]?", { images });
      // Mid-turn a steer carries text only, so a message with an image waits
      // for the next turn instead of losing the image.
      expect(s.state.pending).toEqual([{ id: expect.any(String), text: "what is in [Image #1]?", kind: "queued" }]);
      // The second turn's outcome: the model's answer, or a text-only refusal.
      await waitFor(s, (st) => String(st.lastError ?? "").includes("can't see images") || st.cells.some((c: any) => c.kind === "markdown" && c.text === "Saw it."));
      expect(carried(s)).toBe(true);
      await waitFor(s, (st) => !st.busy);
    }
  }, 120_000);

  it("Enter while a turn runs steers it: the model reads it at the next step", async () => {
    llm.stop();
    llm = startFakeLlm([
      { tool: "grep", args: { pattern: "TODO" }, delayMs: 400 },
      { text: "Checked, including the README." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
    await s.start();
    await s.submit("find the TODOs");
    await s.submit("also check the README");
    expect(s.state.pending.some((p) => p.kind === "steer" && p.text === "also check the README")).toBe(true);
    await waitFor(s, (st) => !st.busy);
    // Delivered inside the same turn, so the SECOND model request carries it.
    const second = JSON.stringify(llm.requests.filter((r: any) => r.tools?.length)[1]?.messages ?? []);
    expect(second).toContain("also check the README");
    expect(s.state.pending).toEqual([]);
    // It is drawn where it reached the agent: before the answer that read it,
    // never after the whole reply (owner, 2026-10-05: "it goes to the bottom").
    const texts = s.state.cells.map((c: any) => (c.kind === "user" ? `U:${c.text}` : c.kind === "markdown" ? `A:${c.text}` : c.kind));
    const steerAt = texts.findIndex((t: string) => t === "U:also check the README");
    const answerAt = texts.findIndex((t: string) => t.includes("Checked, including the README."));
    expect(steerAt).toBeGreaterThan(-1);
    expect(answerAt).toBeGreaterThan(-1);
    expect(steerAt).toBeLessThan(answerAt);
    // One footer, after the whole turn: not one before the message as well.
    expect(texts.filter((t: string) => t === "footer").length).toBe(1);
    expect(texts.at(-1)).toBe("footer");
  }, 60_000);

  it("a steer draws the moment Enter is pressed, before main's interject reply", async () => {
    llm.stop();
    llm = startFakeLlm([
      { tool: "grep", args: { pattern: "TODO" }, delayMs: 400 },
      { text: "Checked." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
    await s.start();
    await s.submit("find the TODOs");
    // Do not await: the "↳ steer" row must appear before main answers (owner,
    // 2026-10-31: a steer showed only after a round trip).
    const steering = s.submit("also check the README");
    expect(s.state.pending.some((p) => p.kind === "steer" && p.text === "also check the README")).toBe(true);
    await steering;
    await waitFor(s, (st) => !st.busy);
  }, 60_000);

  it("userTurn is true for the user's own turn, false for a peer or wake turn", async () => {
    const { AgentSession } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws }) as any;
    expect(s.state.userTurn).toBe(true);
    // startTurn's optimistic update flips the flag before any await; without a
    // registered session it then fails, which the catch swallows.
    const w = s.startTurn("", { continueAfterQuestions: true, systemWake: true });
    expect(s.state.userTurn).toBe(false);
    await w.catch(() => {});
    const p = s.startTurn("", { continueAfterQuestions: true, peerTurn: true });
    expect(s.state.userTurn).toBe(false);
    await p.catch(() => {});
  }, 60_000);

  it("a steer is drawn where the agent TOOK it, even when its row reaches the list after more of the answer", async () => {
    // Main takes the steer (chat:interjections) before the step streams, but the
    // row itself arrives after a database write: by then the answer had grown,
    // and the message was drawn under the reply that read it.
    const { AgentSession } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws }) as any;
    s.state.busy = true;
    s.steerTexts = ["also check the README"];
    s.steers = [{ id: "s1", text: "also check the README", kind: "steer" }];
    const ask = { id: 1, role: "user", content: "find the TODOs" };
    const before = "Looking.";
    s.messages = [ask, { id: 2, role: "assistant", content: before }];
    s.onSend("chat:interjections", { pending: [] });
    s.onSend("chat:response:chunk", {
      messages: [ask, { id: 3, role: "user", content: "also check the README" }, { id: 2, role: "assistant", content: `${before}\n\nChecked the README too.` }],
    });
    expect(s.anchors.get("3")?.offset).toBe(before.length);
    // The reply drawn around it keeps ONE footer, after its last line.
    s.turnFooters.set("2", { text: "Build · 3s", interrupted: false });
    const cells = s.withFooters([
      { kind: "tool", id: "2:t0" },
      { kind: "user", id: "3:u", text: "also check the README" },
      { kind: "markdown", id: "2:m1", text: "Checked the README too." },
    ]);
    expect(cells.map((c: any) => c.kind)).toEqual(["tool", "user", "markdown", "footer"]);
  }, 60_000);

  it("a card a saved rule already answered leaves the screen (allow edits in src/)", async () => {
    // Two edits in src/ asked together; "allow edits in src/" on the first
    // approved the second at once, but its card stayed and was answered again
    // (owner, 2026-10-19). The interceptor says so on `operation-status`.
    const { AgentSession } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws }) as any;
    s.onSend("permission-request", { operationId: "op_a", request: { operation: "edit_file", preview: { path: "src/app.tsx" } } });
    s.onSend("permission-request", { operationId: "op_b", request: { operation: "edit_file", preview: { path: "src/index.tsx" } } });
    expect(s.state.approvals.map((a: any) => a.operationId)).toEqual(["op_a", "op_b"]);
    s.onSend("operation-status", { operationId: "op_b", status: "running" });
    expect(s.state.approvals.map((a: any) => a.operationId)).toEqual(["op_a"]);
    // Still waiting is still a question.
    s.onSend("operation-status", { operationId: "op_a", status: "pending" });
    s.onSend("operation-status", { operationId: "op_a", status: "queued" });
    expect(s.state.approvals.map((a: any) => a.operationId)).toEqual(["op_a"]);
    s.onSend("operation-status", { operationId: "op_a", status: "completed" });
    expect(s.state.approvals).toEqual([]);
    // Nobody answered these here: no "You approved" line for either.
    expect(s.state.cells.some((c: any) => c.id.startsWith("approved:"))).toBe(false);
  }, 60_000);

  it("thinking and the answer reach the screen as they stream, though main keeps writing the row it sent", async () => {
    // Main runs in this process: the row in its first full list is the object it
    // goes on writing. Shared, each patch found its text already there and was
    // dropped as "no change", so nothing showed until the turn ended.
    const { AgentSession } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws }) as any;
    s.state.busy = true;
    const live = { id: 2, role: "assistant", content: "<think>The" };
    s.onSend("chat:response:chunk", { messages: [{ id: 1, role: "user", content: "17*23?" }, live] });
    const patch = (text: string) => {
      const start = live.content.length;
      live.content += text;
      s.onSend("chat:response:chunk", { patch: { messageId: 2, start, text, length: live.content.length } });
    };
    patch(" user asks for a product.");
    expect(s.state.cells.at(-1)).toMatchObject({ kind: "thought", text: "The user asks for a product." });
    patch("</think>391");
    expect(s.state.cells.at(-1)).toMatchObject({ kind: "markdown", text: "391" });
  }, 60_000);

  it("a command that needs approval raises a prompt through the REAL permission path, and approving runs it", async () => {
    llm.stop();
    fs.writeFileSync(path.join(ws, "doomed.txt"), "bye");
    llm = startFakeLlm([
      { tool: "run_command", args: { command: "rm doomed.txt", description: "remove the file" } },
      { text: "Removed." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
    await s.start();
    await s.submit("delete doomed.txt");
    await waitFor(s, (st) => st.approvals.length > 0, 30_000);
    const req = s.state.approvals[0]!;
    expect(JSON.stringify(req.request)).toContain("rm doomed.txt");
    expect(fs.existsSync(path.join(ws, "doomed.txt"))).toBe(true);
    await s.answerApproval(req.operationId, "once");
    await waitFor(s, (st) => !st.busy);
    expect(fs.existsSync(path.join(ws, "doomed.txt"))).toBe(false);
    expect(s.state.cells.filter((c: any) => c.kind !== "footer").at(-1)).toMatchObject({ kind: "markdown", text: "Removed." });
    // What you approved, under the command that asked (as Codex CLI and Claude Code do).
    const cells = s.state.cells as any[];
    const at = cells.findIndex((c) => c.id === `approved:${req.operationId}`);
    expect(cells[at]).toMatchObject({ kind: "notice", level: "info", text: "✓ You approved Atlarix to run `rm doomed.txt` this time" });
    expect(cells[at - 1]).toMatchObject({ kind: "tool" });
  }, 60_000);

  it("Esc stops a long command: the turn ends, the tool reads interrupted, the process is gone, the session lives on", async () => {
    // In its own process, with the CLI's own process guards: a cancelled turn
    // leaves detached SDK promises rejecting with "user_cancel", which the CLI
    // survives (as the desktop does) but `bun test` would count as a failure.
    const proc = Bun.spawnSync(
      ["bun", "--preload", "./tests-bun/preload.ts", "tests-bun/scenarios/esc-interrupt.ts"],
      { cwd: path.resolve(import.meta.dir, ".."), env: { ...process.env }, stderr: "pipe", stdout: "pipe" },
    );
    const out = proc.stdout.toString();
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    expect(line, proc.stderr.toString().slice(-2000)).toBeTruthy();
    const r = JSON.parse(line!.slice(7));
    expect(r.wasRunning).toBe(true);
    expect(r.stoppedWithinMs).toBeLessThan(10_000);
    expect(r.lastError).toBeNull();
    expect(r.toolInterrupted).toBe(true);
    expect(r.noticeShown).toBe(true);
    expect(r.processGone).toBe(true);
    expect(r.nextTurnWorked).toBe(true);
    expect(r.oneToolCell).toBe(true);
    expect(r.toolStillInterrupted).toBe(true);
    expect(r.noCancelText).toBe(true);
  }, 90_000);

  it("a stop before the first token is recorded as stopped, and not as the last turn's reply", async () => {
    // QA 15.7.1 #2: it saved the PREVIOUS reply as the stopped one, then (once
    // that was fixed) nothing at all, so a reopened chat read it as still open.
    const proc = Bun.spawnSync(
      ["bun", "--preload", "./tests-bun/preload.ts", "tests-bun/scenarios/stop-before-first-token.ts"],
      { cwd: path.resolve(import.meta.dir, ".."), env: { ...process.env }, stderr: "pipe", stdout: "pipe" },
    );
    const line = proc.stdout.toString().split("\n").find((l) => l.startsWith("RESULT "));
    expect(line, proc.stderr.toString().slice(-2000)).toBeTruthy();
    expect(JSON.parse(line!.slice(7))).toEqual([
      ["user", "complete", "What is 5+5?"],
      ["assistant", "complete", "10"],
      ["user", "complete", "Write an essay about volcanoes."],
      ["assistant", "interrupted", "[Response cancelled by user]"],
    ]);
  }, 90_000);

  it("with several calls at once, the receipt sits under the call whose card was answered", async () => {
    // A2 (QA 2/2): three edits in one step; the line went under the third.
    llm.stop();
    const w = fs.mkdtempSync(path.join(os.tmpdir(), "cli-a2-ws-"));
    fs.mkdirSync(path.join(w, "src"));
    llm = startFakeLlm([
      { tools: ["q1", "q2", "q3"].map((n) => ({ tool: "edit_file", args: { path: `src/${n}.ts`, operation: "write", content: `export const ${n} = 1;\n` } })) },
      { text: "Wrote them." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: w, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
    await s.start();
    await s.submit("write three files");
    await waitFor(s, (st) => st.approvals.length > 0 && st.cells.filter((c: any) => c.kind === "tool").length >= 3, 30_000);
    const card = s.state.approvals.find((a) => JSON.stringify(a.request).includes("q1.ts"))!;
    await s.answerApproval(card.operationId, "once");
    const cells = s.state.cells as any[];
    const at = cells.findIndex((c) => c.id === `approved:${card.operationId}`);
    expect(cells[at - 1]).toMatchObject({ kind: "tool", tool: { target: "src/q1.ts" } });
    for (const a of s.state.approvals) await s.answerApproval(a.operationId, "once");
    await waitFor(s, (st) => !st.busy, 30_000);
  }, 90_000);

  it("'always allow' is remembered: the next such command does not ask", async () => {
    llm.stop();
    fs.writeFileSync(path.join(ws, "a1.txt"), "1");
    fs.writeFileSync(path.join(ws, "a2.txt"), "2");
    llm = startFakeLlm([
      { tool: "run_command", args: { command: "rm a1.txt", description: "remove" } },
      { text: "First done." },
      { tool: "run_command", args: { command: "rm a2.txt", description: "remove again" } },
      { text: "Second done." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
    await s.start();
    await s.submit("remove a1");
    await waitFor(s, (st) => st.approvals.length > 0, 30_000);
    await s.answerApproval(s.state.approvals[0]!.operationId, "always_allow");
    await waitFor(s, (st) => !st.busy);
    expect(fs.existsSync(path.join(ws, "a1.txt"))).toBe(false);
    let asked = false;
    const on = (st: { approvals: unknown[] }) => void (asked ||= st.approvals.length > 0);
    s.on("change", on);
    await s.submit("remove a2");
    await waitFor(s, (st) => !st.busy && st.cells.some((c: any) => c.kind === "markdown" && c.text === "Second done."), 30_000);
    s.off("change", on);
    expect(asked).toBe(false);
    expect(fs.existsSync(path.join(ws, "a2.txt"))).toBe(false);
  }, 90_000);

  it("in Explore, 'always' on a change saves the rule the gate checks: the next one does not ask", async () => {
    // E6 (QA, 3 of 3): the card carried the gate's `mutate:package-manifest-write`,
    // but "always" saved from the interceptor's copy, which had no key, so it fell
    // back to `npm`, a rule the read-only gate never consults.
    llm.stop();
    const w = fs.mkdtempSync(path.join(os.tmpdir(), "cli-e6-ws-"));
    fs.writeFileSync(path.join(w, "package.json"), JSON.stringify({ name: "qa", version: "1.0.0" }));
    llm = startFakeLlm([
      { tool: "run_command", args: { command: "npm pkg set version=1.0.1", description: "bump" } },
      { text: "Bumped." },
      { tool: "run_command", args: { command: "npm pkg set description=qa", description: "describe" } },
      { text: "Described." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: w, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
    await s.start();
    s.setMode("ask");
    await s.submit("bump the version");
    await waitFor(s, (st) => st.approvals.length > 0, 30_000);
    const card = s.state.approvals[0]!;
    expect(JSON.stringify(card.request)).toContain("mutate:package-manifest-write");
    await s.answerApproval(card.operationId, "always_allow");
    await waitFor(s, (st) => !st.busy);
    // The line says the rule that was saved: a class of change, not "`npm` commands".
    expect((s.state.cells as any[]).find((c) => c.id === `approved:${card.operationId}`)?.text).toBe(
      "✓ You approved Atlarix to always make changes like `npm pkg set version=1.0.1` in this folder",
    );
    let asked = false;
    const on = (st: { approvals: unknown[] }) => void (asked ||= st.approvals.length > 0);
    s.on("change", on);
    await s.submit("now describe it");
    await waitFor(s, (st) => !st.busy && st.cells.some((c: any) => c.kind === "markdown" && c.text === "Described."), 30_000);
    s.off("change", on);
    expect(asked).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(w, "package.json"), "utf8")).description).toBe("qa");
  }, 90_000);

  it("!command runs in the folder, streams into a cell, and the agent sees it with the next message only", async () => {
    llm.stop();
    llm = startFakeLlm([{ text: "That file says hello." }, { text: "Second." }, { text: "Third." }]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
    await s.start();
    fs.writeFileSync(path.join(ws, "hello.txt"), "hello from the file\n");
    await s.runShell("cat hello.txt && exit 3");
    const cell = s.state.cells.find((c) => c.kind === "tool" && c.tool.verb === "!");
    expect(cell).toMatchObject({ kind: "tool", tool: { target: "cat hello.txt && exit 3", status: "error" } });
    expect(cell && cell.kind === "tool" && cell.tool.output).toContain("hello from the file");
    expect(s.sessionId).toBe(""); // a shell run alone starts no session
    await s.submit("what does it say?");
    await waitFor(s, (st) => !st.busy);
    // The turn's request (the session's title is asked of the same model, beside it).
    const first = JSON.stringify(llm.requests.find((r) => r.tools?.length)?.messages ?? []);
    expect(first).toContain("hello from the file");
    expect(first).toContain("exit code 3");
    // The transcript shows what the user typed, not the context block.
    const user = s.state.cells.find((c) => c.kind === "user");
    expect(user).toMatchObject({ text: "what does it say?" });
    // Given once: the next message does not repeat it.
    const n = llm.requests.length;
    await s.submit("and now?");
    await waitFor(s, (st) => !st.busy);
    expect(JSON.stringify(llm.requests.slice(n).at(-1)?.messages.at(-1) ?? "")).not.toContain("hello from the file");
  }, 60_000);

  it("Esc stops a running !command", async () => {
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
    await s.start();
    const started = Date.now();
    const running = s.runShell("sleep 20");
    await waitFor(s, () => s.shellRunning);
    expect(s.stopShell).toBeTruthy();
    s.stopShell!();
    await running;
    expect(Date.now() - started).toBeLessThan(10_000);
    const cell = s.state.cells.find((c) => c.kind === "tool" && c.tool.verb === "!");
    expect(cell).toMatchObject({ tool: { status: "interrupted" } });
    expect(s.shellRunning).toBe(false);
  }, 30_000);

  // A1 (QA, 2/2): a `selectedAgent` left in settings (the picker that wrote it was
  // removed in v14.8.9) applied by halves to every CLI turn: its prompt, with the
  // CLI's own Build tools, so a read-only agent could edit and run commands. A
  // turn never runs as a user agent now; agents are `task` targets only.
  describe("a turn is never a user agent", () => {
    const toolNames = (r: { tools?: unknown[] } | undefined) =>
      (r?.tools ?? []).map((t: any) => t.function?.name ?? t.name);
    const askAgentFolder = () => {
      const w = fs.mkdtempSync(path.join(os.tmpdir(), "cli-agent-ws-"));
      fs.mkdirSync(path.join(w, ".atlarix", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(w, ".atlarix", "agents", "askagent.md"),
        "---\ndescription: QA ask agent\nmode: ask\n---\nYou are the QA ask agent.\n",
      );
      return w;
    };

    it("a stale agent pick in settings is not applied at all", async () => {
      llm.stop();
      llm = startFakeLlm([{ text: "Hi." }]);
      const { writeSettings } = await import("../src/main/settings");
      writeSettings({ selectedAgent: "askagent" } as never);
      try {
        const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
        const s = new AgentSession({ workspaceDir: askAgentFolder(), model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }) });
        await s.start();
        await s.submit("hello");
        await waitFor(s, (st) => !st.busy);
        const turn = llm.requests.find((r) => r.tools?.length);
        expect(JSON.stringify(turn?.messages)).not.toContain("QA ask agent");
        // The CLI's own mode (Build) decides the tools.
        expect(toolNames(turn)).toContain("edit_file");
      } finally {
        writeSettings({ selectedAgent: "" } as never);
      }
    }, 60_000);

  });
});
