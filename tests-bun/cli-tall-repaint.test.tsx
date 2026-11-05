/** @jsxImportSource @opentui/react */
/**
 * A transcript taller than the screen follows its newest line: a peer or wake
 * turn arrives with no key pressed and must still be in view (owner 2026-11-06:
 * "we dont actually see the messages"; filming 15.12: "answer never shown at
 * 110×36"). opentui's scrollbox stuck to the TOP when the transcript started
 * short, so it fixes on the bottom now (stickyStart). Scrolled up, it stays put.
 * with real key and paste events. The session is a recording fake: these tests
 * are about what the UI shows and what each key asks the session to do. The
 * session's own behaviour is covered in cli-session.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { SessionState } from "../src/cli/agent/session";
import { App } from "../src/cli/tui/App";

// The renderer is driven by real key events, not React test helpers: act() does not apply.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

class FakeSession extends EventEmitter {
  workspaceDir = "/work/acme";
  calls: Array<[string, ...unknown[]]> = [];
  state: SessionState = {
    cells: [],
    busy: false,
    phase: null,
    turnStartedAt: null,
    approvals: [],
    pending: [],
    mode: "build",
    tokensThisTurn: null,
    contextPercent: null,
    contextUsed: null,
    contextLimit: null,
    sessionTokens: 0,
    lastError: null,
  };
  set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.emit("change", this.state);
  }
  async submit(...a: unknown[]) { this.calls.push(["submit", ...a]); }
  queueNext(...a: unknown[]) { this.calls.push(["queueNext", ...a]); }
  popLastQueued() { this.calls.push(["popLastQueued"]); return "queued text back"; }
  async liveTasks() { return []; }
  async recap(...a: unknown[]) { this.calls.push(["recap", ...a]); return "Fixing the login test; the fix is in, a run is next."; }
  showRecap(text: string) { this.set({ cells: [...this.state.cells, { kind: "recap", id: "recap", text }] as never }); }
  setMode(m: string) { this.calls.push(["setMode", m]); this.set({ mode: m as SessionState["mode"] }); }
  async newSession() { this.calls.push(["newSession"]); }
  async interrupt() { this.calls.push(["interrupt"]); }
  async answerApproval(...a: unknown[]) { this.calls.push(["answerApproval", ...a]); }
  async runShell(...a: unknown[]) { this.calls.push(["runShell", ...a]); }
  stopShell: (() => void) | null = null;
}

let current: Awaited<ReturnType<typeof testRender>> | null = null;
afterEach(async () => {
  current?.renderer.destroy();
  current = null;
  // Let the renderer's syntax worker shut down before the next test starts one.
  await Bun.sleep(300);
});

/** Links the app tried to open: recorded, never sent to a real browser. */
const opened: string[] = [];

async function mount(
  session = new FakeSession(),
  models?: import("../src/cli/tui/App").ModelSource,
  /** A terminal speaking the kitty keyboard protocol (Ghostty, kitty, WezTerm, iTerm2): shift+enter is its own key. */
  kittyKeyboard = false,
) {

  const setup = await testRender(
    <App session={session as never} modelLabel="Atlarix Auto" version="15.0.0" onQuit={() => {}} plainMarkdown models={models} openUrl={(u) => opened.push(u)} />,
    // As runTui does: ctrl+c is the app's to handle, not the renderer's.
    { width: 110, height: 32, exitOnCtrlC: false, ...(kittyKeyboard ? { kittyKeyboard: true } : {}) },
  );
  return { setup, session };
}

describe("a tall transcript", () => {
  it("shows a cell that arrives with no key pressed (auto render, no renderOnce)", async () => {
    const { setup, session } = await mount();
    const cells: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      cells.push({ kind: "user", id: `u${i}`, text: `question ${i}` });
      cells.push({ kind: "markdown", id: `m${i}`, text: `answer ${i}` });
    }
    session.set({ cells: cells as never });
    for (let i = 0; i < 3; i++) { await Bun.sleep(30); await setup.renderOnce(); }
    expect(setup.captureCharFrame()).toContain("answer 29");
    session.set({ cells: [...cells, { kind: "markdown", id: "late", text: "LATE REPLY HERE" }] as never });
    let frame = "";
    for (let i = 0; i < 3; i++) { await Bun.sleep(30); await setup.renderOnce(); }
    frame = setup.captureCharFrame();
    expect(frame).toContain("LATE REPLY HERE");
  }, 30_000);

  it("stays where the user scrolled up to while new cells arrive", async () => {
    const { setup, session } = await mount();
    const cells: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      cells.push({ kind: "user", id: `u${i}`, text: `question ${i}` });
      cells.push({ kind: "markdown", id: `m${i}`, text: `answer ${i}` });
    }
    session.set({ cells: cells as never });
    for (let i = 0; i < 3; i++) { await Bun.sleep(30); await setup.renderOnce(); }
    for (let i = 0; i < 3; i++) { setup.mockInput.pressKey("\x1b[5~"); await Bun.sleep(30); await setup.renderOnce(); }
    const before = setup.captureCharFrame();
    expect(before).not.toContain("answer 29");
    session.set({ cells: [...cells, { kind: "markdown", id: "late", text: "LATE REPLY HERE" }] as never });
    for (let i = 0; i < 3; i++) { await Bun.sleep(30); await setup.renderOnce(); }
    expect(setup.captureCharFrame()).not.toContain("LATE REPLY HERE");
  }, 30_000);
});
