/** @jsxImportSource @opentui/react */
/**
 * The CLI's screen, rendered headlessly (opentui's test renderer) and driven
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
  let quit = 0;
  const setup = await testRender(
    <App session={session as never} modelLabel="Atlarix Auto" version="15.0.0" onQuit={() => void quit++} plainMarkdown models={models} openUrl={(u) => opened.push(u)} />,
    // As runTui does: ctrl+c is the app's to handle, not the renderer's.
    { width: 110, height: 32, exitOnCtrlC: false, ...(kittyKeyboard ? { kittyKeyboard: true } : {}) },
  );
  current = setup;
  await setup.renderOnce();
  return { setup, session, quits: () => quit };
}

async function frameContaining(setup: Awaited<ReturnType<typeof testRender>>, text: string, ms = 5000) {
  const end = Date.now() + ms;
  let frame = "";
  while (Date.now() < end) {
    await Bun.sleep(50);
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    if (frame.includes(text)) return frame;
  }
  return frame;
}

const settle = async (setup: Awaited<ReturnType<typeof testRender>>) => {
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(20);
    await setup.renderOnce();
  }
};

describe("the screen", () => {
  it("shows the header, the transcript and the status line", async () => {
    const { setup, session } = await mount();
    session.set({
      cells: [
        { kind: "user", id: "1", text: "find the TODOs" },
        { kind: "tool", id: "2", tool: { id: "t", verb: "Search", target: '"TODO"', status: "success" } },
        { kind: "markdown", id: "3", text: "One TODO, in a.ts." },
      ],
    });
    // Markdown is parsed off-thread; poll in real time until it has drawn.
    const frame = await frameContaining(setup, "One TODO, in a.ts.");
    // The status is set into the prompt box's top border (no separate line).
    expect(frame).toContain("› find the TODOs");
    expect(frame).toContain('◇ Search "TODO"');
    expect(frame).toContain("One TODO, in a.ts.");
    expect(frame).toContain("╭─ Build · Atlarix Auto");
  });

  it("never names the model behind Atlarix Auto", async () => {
    const { setup } = await mount();
    expect(setup.captureCharFrame()).not.toMatch(/glm|gpt|luna|sol|astra/i);
  });
});

describe("the prompt box", () => {
  it("Enter sends what was typed", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("fix the login bug");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(session.calls[0]).toEqual(["submit", "fix the login bug", { display: "fix the login bug", images: [] }]);
  });

  it("a long paste becomes [Pasted text #1 +N lines] and is expanded only when sent", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("see ");
    await setup.mockInput.pasteBracketedText("line one\nline two\nline three\nline four");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("[Pasted text #1 +4 lines]");
    setup.mockInput.pressEnter();
    await settle(setup);
    const [, prompt, opts] = session.calls[0]!;
    expect(prompt).toBe("see line one\nline two\nline three\nline four");
    expect((opts as { display: string }).display).toBe("see [Pasted text #1 +4 lines]");
  });

  it("a pasted image path becomes [Image #1] and is sent as an image", async () => {
    const img = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tui-img-")), "shot.png");
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { setup, session } = await mount();
    await setup.mockInput.pasteBracketedText(img);
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("[Image #1]");
    setup.mockInput.pressEnter();
    await settle(setup);
    const opts = session.calls[0]![2] as { images: Array<{ path: string }> };
    expect(opts.images.map((i) => i.path)).toEqual([img]);
  });

  it("pasting the same text again opens the chip into the full text, to edit", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("see ");
    await setup.mockInput.pasteBracketedText("line one\nline two\nline three");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("[Pasted text #1");
    await setup.mockInput.pasteBracketedText("line one\nline two\nline three");
    await settle(setup);
    const f = setup.captureCharFrame();
    expect(f).not.toContain("[Pasted text");
    expect(f).toContain("line two");
    setup.mockInput.pressEnter();
    await settle(setup);
    const [, prompt] = session.calls[0]!;
    expect(prompt).toBe("see line one\nline two\nline three");
  });

  it("backspace removes a placeholder whole", async () => {
    const { setup } = await mount();
    await setup.mockInput.pasteBracketedText("a\nb\nc\nd");
    await settle(setup);
    setup.mockInput.pressBackspace(); // the space after the label
    setup.mockInput.pressBackspace(); // the whole label
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("[Pasted text");
  });
});

describe("while a turn runs", () => {
  it("Tab queues for after the turn; the queue and steers are listed", async () => {
    const { setup, session } = await mount();
    session.set({ busy: true, turnStartedAt: Date.now(), phase: "Thinking…" });
    await setup.mockInput.typeText("then run the tests");
    setup.mockInput.pressTab();
    await settle(setup);
    expect(session.calls).toContainEqual(["queueNext", "then run the tests"]);
    session.set({
      pending: [
        { id: "s1", text: "use the redis store", kind: "steer" },
        { id: "q1", text: "then run the tests", kind: "queued" },
      ],
    });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("↳ steer  use the redis store");
    expect(frame).toContain("↳ queued then run the tests");
    expect(frame).toContain("Thinking…");
  });

  it("Esc stops the turn", async () => {
    const { setup, session } = await mount();
    session.set({ busy: true, turnStartedAt: Date.now() });
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(session.calls).toContainEqual(["interrupt"]);
  });

  it("alt+↑ pulls the last queued message back into the box", async () => {
    const { setup, session } = await mount();
    setup.mockInput.pressArrow("up", { meta: true });
    await settle(setup);
    expect(session.calls).toContainEqual(["popLastQueued"]);
    expect(setup.captureCharFrame()).toContain("queued text back");
  });
});

describe("keys and commands", () => {
  for (const [label, press] of [
    ["shift+enter", (m: Awaited<ReturnType<typeof mount>>["setup"]["mockInput"]) => m.pressEnter({ shift: true })],
    ["option+enter", (m: Awaited<ReturnType<typeof mount>>["setup"]["mockInput"]) => m.pressEnter({ meta: true })],
    ["ctrl+j", (m: Awaited<ReturnType<typeof mount>>["setup"]["mockInput"]) => m.pressKey("j", { ctrl: true })],
  ] as const) {
    it(`${label} adds a line; enter alone sends`, async () => {
      // shift+enter only exists where the terminal reports it (the kitty
      // protocol, which the CLI turns on); a legacy terminal sends it as enter.
      const { setup, session } = await mount(undefined, undefined, label === "shift+enter");
      await setup.mockInput.typeText("one");
      press(setup.mockInput);
      await setup.mockInput.typeText("two");
      await settle(setup);
      expect(session.calls.some((c) => c[0] === "submit")).toBe(false);
      setup.mockInput.pressEnter();
      await settle(setup);
      expect(session.calls.find((c) => c[0] === "submit")?.[1]).toBe("one\ntwo");
    });
  }


  it("a backslash then enter adds a line in any terminal (Apple's Terminal sends shift+enter as enter)", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("one\\");
    setup.mockInput.pressEnter();
    await setup.mockInput.typeText("two");
    await settle(setup);
    expect(session.calls.some((c) => c[0] === "submit")).toBe(false);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(session.calls.find((c) => c[0] === "submit")?.[1]).toBe("one\ntwo");
  });

  it("shift+tab cycles Build → Explore → Plan → Debug → Review", async () => {
    const { setup, session } = await mount();
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(session.calls.filter((c) => c[0] === "setMode")).toEqual([["setMode", "ask"], ["setMode", "plan"]]);
    expect(setup.captureCharFrame()).toContain("Plan · Atlarix Auto");
    for (let i = 0; i < 3; i++) {
      setup.mockInput.pressTab({ shift: true });
      await settle(setup);
    }
    expect(session.calls.filter((c) => c[0] === "setMode").map((c) => c[1])).toEqual(["ask", "plan", "debug", "review", "build"]);
  });

  it("ctrl+y switches the mode as shift+tab does (VS Code can take shift+tab)", async () => {
    const { setup, session } = await mount();
    setup.mockInput.pressKey("y", { ctrl: true });
    await settle(setup);
    expect(session.calls.filter((c) => c[0] === "setMode").map((c) => c[1])).toEqual(["ask"]);
  });

  it("page up and down scroll the conversation", async () => {
    const { setup, session } = await mount();
    session.set({ cells: Array.from({ length: 80 }, (_, i) => ({ kind: "markdown", id: `m${i}`, text: `line number ${i}` })) } as never);
    await settle(setup);
    // stickyScroll doesn't work in test env - scroll to bottom with Page Down first
    for (let i = 0; i < 10; i++) {
      setup.mockInput.pressKey("\x1b[6~"); // Page Down
      await settle(setup);
    }
    // Now we should be at the bottom showing line 79
    expect(setup.captureCharFrame()).toContain("line number 79");
    // Page Up should scroll away from line 79
    setup.mockInput.pressKey("\x1b[5~"); // Page Up
    for (let i = 0; i < 10; i++) {
      await settle(setup);
      if (!setup.captureCharFrame().includes("line number 79")) break;
    }
    expect(setup.captureCharFrame()).not.toContain("line number 79");
  });

  it("shift+tab switches the mode even with the / menu open", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("/");
    await settle(setup);
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(session.calls.filter((c) => c[0] === "setMode").map((c) => c[1])).toEqual(["ask"]);
  });

  it("/mode picks any of the five modes", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("/mode");
    setup.mockInput.pressEnter();
    const frame = await frameContaining(setup, "Review");
    for (const m of ["Build", "Explore", "Plan", "Debug", "Review"]) expect(frame).toContain(m);
    for (let i = 0; i < 3; i++) setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(session.calls).toContainEqual(["setMode", "debug"]);
  });

  it("an unknown /command is not sent to Atlarix; /commands and / show the list; /exit quits", async () => {
    const { setup, session, quits } = await mount();
    await setup.mockInput.typeText("/nonsense");
    setup.mockInput.pressEnter();
    expect(await frameContaining(setup, "no /nonsense command")).toContain("Type / to see them all");
    expect(session.calls.some((c) => c[0] === "submit")).toBe(false);
    await setup.mockInput.typeText("/commands");
    setup.mockInput.pressEnter();
    expect(await frameContaining(setup, "/resume")).toContain("/model");
    expect(session.calls.some((c) => c[0] === "submit")).toBe(false);
    setup.mockInput.pressKey("u", { ctrl: true });
    for (let i = 0; i < 12; i++) setup.mockInput.pressBackspace();
    await settle(setup);
    await setup.mockInput.typeText("/exit");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(quits()).toBe(1);
  });

  it("a long thought shows as one dim line ending in …; ctrl+o shows all of it", async () => {
    const { setup, session } = await mount();
    const long = "Let me look at the top-level workspace structure and read the rules and the package files before anything else. ".repeat(3);
    session.set({ cells: [{ kind: "user", id: "u", text: "explain" }, { kind: "thought", id: "t", text: long + "\nSecond line." }] });
    let frame = await frameContaining(setup, "∴");
    const thoughtLine = frame.split("\n").find((l) => l.includes("∴"))!;
    expect(thoughtLine.trim().endsWith("…")).toBe(true);
    expect(frame).not.toContain("Second line.");
    setup.mockInput.pressKey("o", { ctrl: true });
    frame = await frameContaining(setup, "Second line.");
    expect(frame).toContain("Second line.");
  });

  it("/ opens the command list, and Enter runs the highlighted one", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("/ne");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Start a fresh session in this folder");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(session.calls).toContainEqual(["newSession"]);
  });

  it("ctrl+c clears the box; twice on an empty box quits", async () => {
    const { setup, quits } = await mount();
    await setup.mockInput.typeText("draft");
    setup.mockInput.pressCtrlC();
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("draft");
    expect(quits()).toBe(0);
    setup.mockInput.pressCtrlC();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("press ctrl+c again to quit");
    setup.mockInput.pressCtrlC();
    await settle(setup);
    expect(quits()).toBe(1);
  });
});

describe("the permission prompt", () => {
  const approval = {
    operationId: "op1",
    request: { operation: "run_command", preview: { command: "npm install express-rate-limit", description: "install the limiter" } },
  };

  it("an edit shows its diff from old and new contents (edit_file's `diff` is an object, which crashed it)", async () => {
    const { setup, session } = await mount();
    session.set({
      approvals: [
        {
          operationId: "op-edit",
          request: {
            operation: "edit_file",
            preview: {
              path: "src/math.js",
              type: "update",
              description: "Surgical replace",
              oldContent: "function add(a, b) {\n  return a - b;\n}\n",
              content: "function add(a, b) {\n  return a + b;\n}\n",
              diff: { added: 1, removed: 1, old_snippet: "return a - b;", new_snippet: "return a + b;" },
            },
          },
        },
      ],
    });
    const frame = await frameContaining(setup, "return a + b;");
    expect(frame).toContain("Edit this file?");
    expect(frame).toContain("src/math.js");
    expect(frame).toContain("-   return a - b;");
    expect(frame).toContain("+   return a + b;");
    expect(frame).toContain("+1 −1");
  });

  it("shows the command and the choices, and 1 approves once", async () => {
    const { setup, session } = await mount();
    session.set({ approvals: [approval] });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Run this command?");
    expect(frame).toContain("$ npm install express-rate-limit");
    expect(frame).toContain("Yes, and always allow `npm` commands in this folder");
    setup.mockInput.pressKey("1");
    await settle(setup);
    expect(session.calls).toContainEqual(["answerApproval", "op1", "once"]);
  });

  it("Esc answers no", async () => {
    const { setup, session } = await mount();
    session.set({ approvals: [approval] });
    await settle(setup);
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(session.calls).toContainEqual(["answerApproval", "op1", "deny"]);
  });

  it("a risky command can be always-allowed (as in the desktop), and says why in the desktop's words", async () => {
    const { setup, session } = await mount();
    session.set({
      approvals: [
        {
          operationId: "op2",
          request: { preview: { command: "curl -sS -o page.html https://example.com", description: "download", isDangerous: true, dangerExplanation: "Downloads from the network into your project." } },
        },
      ],
    });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Yes, and always allow this command in this folder");
    expect(frame).toContain("Downloads from the network into your project.");
    expect(frame).not.toContain("can't be undone");
  });

  it("a change outside the project is never offered 'always'", async () => {
    const { setup, session } = await mount();
    session.set({ approvals: [{ operationId: "op4", request: { preview: { command: "brew install jq", description: "d", canAlwaysAllow: false, systemScope: true } } }] });
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("always allow");
  });

  it("a flagged command with no explanation gets a neutral line", async () => {
    const { setup, session } = await mount();
    session.set({ approvals: [{ operationId: "op3", request: { preview: { command: "x", description: "d", isDangerous: true } } }] });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("This command is flagged as risky.");
  });
});

describe("parity details", () => {
  it("an empty session shows the header: Rix, version, model and mode, folder", async () => {
    const { setup } = await mount();
    const frame = await frameContaining(setup, "Atlarix v15.0.0");
    const lines = frame.split("\n");
    // Left-aligned, at the top — not a centred splash.
    expect(lines[0]).toMatch(/^\s{0,3}\S/);
    expect(lines[0]).toContain("Atlarix v15.0.0");
    expect(frame).toContain("Atlarix Auto · Build");
    expect(frame).toContain("/work/acme");
    expect(frame).toContain("/commands");
    expect(frame).toMatch(/[▀▄█]/); // Rix
  });

  it("the header stays as the first line once the conversation starts", async () => {
    const { setup, session } = await mount();
    session.set({ cells: [{ id: "u1", kind: "user", text: "hello there" }] as never });
    const frame = await frameContaining(setup, "hello there");
    expect(frame.split("\n")[0]).toContain("Atlarix v15.0.0");
    expect(frame).not.toContain("Ask anything");
  });

  it("/help opens a key list, any key closes it", async () => {
    const { setup } = await mount();
    await setup.mockInput.typeText("/help");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("pull the last queued message back");
    setup.mockInput.pressKey("x");
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("pull the last queued message back");
  });

  it("↑ on an empty box recalls earlier prompts, ↓ comes back", async () => {
    const { setup } = await mount();
    await setup.mockInput.typeText("first prompt");
    setup.mockInput.pressEnter();
    await settle(setup);
    await setup.mockInput.typeText("second prompt");
    setup.mockInput.pressEnter();
    await settle(setup);
    setup.mockInput.pressArrow("up");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("second prompt");
    setup.mockInput.pressArrow("up");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("first prompt");
    setup.mockInput.pressArrow("down");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("second prompt");
  });

  it("every tool line has a one-line summary; ctrl+o shows readable output", async () => {
    const { setup, session } = await mount();
    session.set({
      cells: [
        {
          kind: "tool",
          id: "1",
          tool: { id: "t", verb: "Run", target: "ls", status: "success", summary: "a.txt · 2 more", output: "a.txt\nb.txt\nc.txt" },
        },
      ],
    });
    await settle(setup);
    // A command shows the start of its output (up to 5 lines), not just its first line.
    const collapsed = setup.captureCharFrame();
    expect(collapsed).toContain("╰ a.txt");
    expect(collapsed).toContain("c.txt");
    setup.mockInput.pressKey("o", { ctrl: true });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("c.txt");
    expect(frame).not.toContain("{");
  });

  it("a failed command is one line: its error and the exit code; ctrl+o shows all of it", async () => {
    const { setup, session } = await mount();
    session.set({
      cells: [
        {
          kind: "tool",
          id: "1",
          tool: {
            id: "t",
            verb: "Run",
            target: "gh pr create",
            status: "error",
            summary: "pull request create failed · exit 1",
            output: "pull request create failed: GraphQL: Head sha can't be blank\nsecond line of the error\nthird line",
          },
        },
      ],
    });
    await settle(setup);
    const collapsed = setup.captureCharFrame();
    expect(collapsed).toContain("╰ pull request create failed");
    expect(collapsed).toContain("· exit 1");
    expect(collapsed).not.toContain("second line of the error");
    setup.mockInput.pressKey("o", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("second line of the error");
  });

  it("ctrl+o is a detail view of its own: everything in full, the box hidden; esc goes back", async () => {
    const { setup, session } = await mount();
    session.set({
      cells: [
        { kind: "user", id: "u", text: "list the files" },
        { kind: "tool", id: "1", tool: { id: "t", verb: "Run", target: "ls", status: "success", summary: "a", output: Array.from({ length: 9 }, (_, i) => `file${i + 1}`).join("\n") } },
      ],
    });
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("more lines (ctrl+o)");
    expect(frame).not.toContain("ctrl+o expand");
    setup.mockInput.pressKey("o", { ctrl: true });
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain("Detail view");
    expect(frame).toContain("file9");
    expect(frame).not.toContain("Ask Atlarix to build");
    setup.mockInput.pressEscape();
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("Detail view");
    expect(frame).toContain("Ask Atlarix to build");
    expect(frame).not.toContain("file9");
  });

  it("a command you ran with ! is a band with \"!\"; a /command in your message stands out", async () => {
    const { setup, session } = await mount();
    session.set({
      cells: [
        { kind: "user", id: "u", text: "/review the auth module" },
        { kind: "tool", id: "s", tool: { id: "s", verb: "!", target: "git status", status: "success", summary: "nothing to commit", output: "nothing to commit" } },
      ],
    });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("› /review the auth module");
    expect(frame).toContain("! git status");
    expect(frame).toContain("╰ nothing to commit");
  });

  it("the working line names the activity; the border shows how full the context is, not the session total", async () => {
    const { setup, session } = await mount();
    session.set({
      busy: true,
      turnStartedAt: Date.now(),
      contextPercent: 23,
      contextUsed: 47_000,
      contextLimit: 205_000,
      sessionTokens: 4_747_000,
      cells: [{ kind: "tool", id: "1", tool: { id: "t", verb: "Run", target: "npm test", status: "running" } }],
    });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Running npm test…");
    // 15.12: the border shows only the percentage, not the raw token counts (owner, 2026-10-31).
    expect(frame).toContain("context 23%");
    expect(frame).not.toContain("47k/205k");
    expect(frame).not.toContain("4.7M");
  });
});

describe("/model, /effort and ctrl+t", () => {
  const AUTO = { kind: "effort", levels: ["low", "medium", "max"], defaultLevel: "medium" };
  // OpenAI's own route runs medium when nothing is chosen (defaultFor).
  const GPT = { kind: "effort", levels: ["none", "low", "medium", "high", "xhigh", "max"], defaultLevel: "medium" };
  const options = [
    { provider: "compass", name: "core-auto", label: "Atlarix Auto", providerName: "Atlarix", detail: "", deepThinking: true, free: true, effortChoices: AUTO },
    { provider: "openai", name: "gpt-6-luna", label: "GPT-6 Luna", providerName: "OpenAI", detail: "OpenAI", deepThinking: true, effortChoices: GPT },
    { provider: "local", name: "plain", label: "Plain model", providerName: "Local", detail: "", deepThinking: false },
  ];
  const source = (selected = { provider: "compass", name: "core-auto" }) => {
    const calls: Array<[string, unknown]> = [];
    let state = { recent: [] as Array<{ provider: string; name: string }>, favorites: [] as Array<{ provider: string; name: string }> };
    return {
      calls,
      src: {
        load: async () => options,
        state: () => state,
        save: (st: typeof state) => {
          state = st;
          calls.push(["save", st]);
        },
        choose: (ref: unknown) => calls.push(["choose", ref]),
        setEffort: (patch: unknown) => calls.push(["effort", patch]),
        selected: async () => selected,
      },
    };
  };

  it("starts on the remembered label and corrects it once the model list loads, remembering it", async () => {
    // The terminal draws before any model list is built (that held the first
    // frame back ~2s); the label comes from cli-state and is fixed up here.
    const { calls, src } = source();
    (src.state() as { model?: unknown }).model = { provider: "openai", name: "gpt-6-luna" };
    const { setup } = await mount(undefined, src as never);
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("GPT-6 Luna");
    const saved = calls.filter((c) => c[0] === "save").map((c) => (c[1] as { modelLabel?: unknown }).modelLabel);
    expect(saved).toContainEqual({ provider: "openai", name: "gpt-6-luna", label: "GPT-6 Luna" });
  });

  it("/model opens the picker, typing filters, enter chooses and the status shows it", async () => {
    const { calls, src } = source();
    const { setup } = await mount(undefined, src as never);
    await setup.mockInput.typeText("/model");
    setup.mockInput.pressEnter();
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Select model");
    expect(frame).toContain("Atlarix Auto");
    await setup.mockInput.typeText("gpt");
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain("GPT-6 Luna");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls).toContainEqual(["choose", { provider: "openai", name: "gpt-6-luna" }]);
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("Select model");
    expect(frame).toContain("Build · GPT-6 Luna");
  });

  it("ctrl+f marks a favourite; esc closes", async () => {
    const { calls, src } = source();
    const { setup } = await mount(undefined, src as never);
    await setup.mockInput.typeText("/model");
    setup.mockInput.pressEnter();
    await settle(setup);
    setup.mockInput.pressKey("f", { ctrl: true });
    await settle(setup);
    const saved = calls.filter((c) => c[0] === "save").at(-1)?.[1] as { favorites: unknown[] };
    expect(saved.favorites).toEqual([{ provider: "compass", name: "core-auto" }]);
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("Select model");
  });

  it("ctrl+t puts the effort at the top of the model's list, and back to its default", async () => {
    const { calls, src } = source();
    const { setup } = await mount(undefined, src as never);
    await settle(setup);
    setup.mockInput.pressKey("t", { ctrl: true });
    await settle(setup);
    expect(calls).toContainEqual(["effort", { effort: "max", deepThinking: true }]);
    expect(setup.captureCharFrame()).toContain("Atlarix Auto · max");
    setup.mockInput.pressKey("t", { ctrl: true });
    await settle(setup);
    // Back to the default: stored as unset, so it follows the next model's own default.
    expect(calls).toContainEqual(["effort", { effort: "", deepThinking: false }]);
    // The default is not named beside the model.
    expect(setup.captureCharFrame()).not.toMatch(/Atlarix Auto · (max|medium)/);
  });

  it("/effort lists the model's own levels exactly as listed, and enter chooses one", async () => {
    const { calls, src } = source({ provider: "openai", name: "gpt-6-luna" });
    const { setup } = await mount(undefined, src as never);
    await setup.mockInput.typeText("/effort");
    setup.mockInput.pressEnter();
    await settle(setup);
    const frame = setup.captureCharFrame();
    for (const l of ["none", "low", "medium", "high", "xhigh", "max"]) expect(frame).toContain(l);
    expect(frame).toContain("default");
    // It opens on the current level (the default, medium); one down is high.
    setup.mockInput.pressArrow("down");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls).toContainEqual(["effort", { effort: "high", deepThinking: false }]);
  });

  it("/effort <level> sets it; a level the model doesn't list names the ones it does", async () => {
    const { calls, src } = source();
    const { setup } = await mount(undefined, src as never);
    await setup.mockInput.typeText("/effort low");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls).toContainEqual(["effort", { effort: "low", deepThinking: false }]);
    expect(setup.captureCharFrame()).toContain("Atlarix Auto · low");
    await setup.mockInput.typeText("/effort xhigh");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("low, medium, max");
  });

  it("a model without the level goes back to its own default; none for a model with no setting", async () => {
    const { calls, src } = source({ provider: "openai", name: "gpt-6-luna" });
    const { setup } = await mount(undefined, src as never);
    await setup.mockInput.typeText("/effort none");
    setup.mockInput.pressEnter();
    await settle(setup);
    await setup.mockInput.typeText("/model");
    setup.mockInput.pressEnter();
    await settle(setup);
    await setup.mockInput.typeText("plain");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls).toContainEqual(["effort", { effort: "", deepThinking: false }]);
    // A model with no levels has no default to be back at.
    expect(setup.captureCharFrame()).not.toContain("Effort is back to its default");
    await setup.mockInput.typeText("/effort");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("This model has no effort setting");
  });
});

describe("@ and !", () => {
  it("@ lists workspace files as you type; tab puts the path in the box", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-at-"));
    fs.mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "auth", "login.ts"), "");
    fs.writeFileSync(path.join(dir, "README.md"), "");
    const session = new FakeSession();
    session.workspaceDir = dir;
    const { setup } = await mount(session);
    await setup.mockInput.typeText("look at @logi");
    const frame = await frameContaining(setup, "src/auth/login.ts");
    expect(frame).toContain("src/auth/login.ts");
    setup.mockInput.pressTab();
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(session.calls[0]?.[0]).toBe("submit");
    expect(session.calls[0]?.[1]).toBe("look at src/auth/login.ts");
  });

  it("!command runs it as the user's own command, not a message", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("!git status");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("› !git status");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(session.calls).toEqual([["runShell", "git status"]]);
  });

  it("Esc stops a running !command", async () => {
    const { setup, session } = await mount();
    let stopped = 0;
    session.stopShell = () => void stopped++;
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(stopped).toBe(1);
    expect(session.calls).not.toContainEqual(["interrupt"]);
  });
});

describe("copy on select", () => {
  it("dragging over text copies it when the mouse is let go, and says so", async () => {
    const copiedTexts: string[] = [];
    const session = new FakeSession();
    session.state.cells = [{ kind: "markdown", id: "a:0", text: "The answer is forty-two." }];
    const setup = await testRender(
      <App
        session={session as never}
        modelLabel="Atlarix Auto"
        version="15.0.0"
        onQuit={() => {}}
        plainMarkdown
        copy={async (t) => {
          copiedTexts.push(t);
          return true;
        }}
      />,
      { width: 110, height: 32, exitOnCtrlC: false },
    );
    current = setup;
    const frame = await frameContaining(setup, "The answer is forty-two.");
    const row = frame.split("\n").findIndex((l) => l.includes("The answer is forty-two."));
    const col = frame.split("\n")[row]!.indexOf("The answer");
    expect(row).toBeGreaterThan(-1);
    await setup.mockMouse.drag(col, row, col + "The answer".length - 1, row);
    await settle(setup);
    expect(copiedTexts.at(-1)).toBe("The answer");
    expect(await frameContaining(setup, "Copied 10 characters")).toContain("Copied 10 characters");
    // ...and the keyboard is back in the prompt box: typing lands there.
    await setup.mockInput.typeText("after the copy");
    expect(await frameContaining(setup, "after the copy")).toContain("› after the copy");
  });
});

describe("the prompt box colours what it will do", () => {
  const fake = (plainText: string) => {
    const added: Array<{ start: number; end: number }> = [];
    return { added, t: { plainText, removeHighlightsByRef() {}, addHighlightByCharRange: (h: { start: number; end: number }) => void added.push(h) } };
  };
  it("a known /command and a shell \"!\"; not an unknown /word or plain text", async () => {
    const { paintCommand } = await import("../src/cli/tui/Composer");
    for (const [text, range] of [
      ["/model gpt", { start: 0, end: 6 }],
      ["!ls -la", { start: 0, end: 1 }],
      ["/notacommand", null],
      ["fix the /model picker", null],
    ] as const) {
      const { added, t } = fake(text);
      paintCommand(t as never);
      expect(added[0] ? { start: added[0].start, end: added[0].end } : null).toEqual(range);
    }
  });

  it("/recap writes one line on where the session stands, shown under the conversation", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("/recap");
    setup.mockInput.pressEnter();
    const frame = await frameContaining(setup, "While you were away");
    expect(frame).toContain("Fixing the login test");
    expect(session.calls.some((c) => c[0] === "recap")).toBe(true);
  });
});

/**
 * A6 (ai-2f): following a turn another surface runs, /undo and /compact went
 * into the after-this-turn queue with nothing said, then fired on their own
 * when that turn ended; a mode change said nothing either.
 */
describe("following a turn another surface runs", () => {
  const NOTE = "Running in the app — wait for it to finish.";
  class FollowingSession extends FakeSession {
    following = true;
    followingNote() {
      return this.following ? NOTE : null;
    }
    override setMode(m: string) {
      this.calls.push(["setMode", m]);
      if (this.following) return NOTE as never;
      this.set({ mode: m as SessionState["mode"] });
      return null as never;
    }
    myMessages() {
      this.calls.push(["myMessages"]);
      return [{ id: 1, text: "earlier" }];
    }
    async compact() {
      this.calls.push(["compact"]);
      return { ok: true, message: "Compacted." };
    }
  }

  for (const cmd of ["/undo", "/compact"]) {
    it(`${cmd} says why it waits, and does not run by itself when that turn ends`, async () => {
      const session = new FollowingSession();
      session.set({ busy: true, following: { surface: "app", name: "x" } } as never);
      const { setup } = await mount(session);
      await setup.mockInput.typeText(cmd);
      await settle(setup);
      setup.mockInput.pressEnter();
      const frame = await frameContaining(setup, "wait for it to finish");
      expect(frame).toContain(NOTE);
      expect(frame).not.toContain("runs after this turn");

      session.following = false;
      session.set({ busy: false, following: undefined } as never);
      await settle(setup);
      await Bun.sleep(200);
      await settle(setup);
      expect(session.calls.some((c) => c[0] === "myMessages" || c[0] === "compact")).toBe(false);
      expect(setup.captureCharFrame()).not.toContain("Go back to a message");
    });
  }

  it("shift+tab says why the mode stays", async () => {
    const session = new FollowingSession();
    session.set({ busy: true, following: { surface: "app", name: "x" } } as never);
    const { setup } = await mount(session);
    setup.mockInput.pressTab({ shift: true });
    expect(await frameContaining(setup, "wait for it to finish")).toContain(NOTE);
    expect(session.state.mode).toBe("build");
  });
});
