/** @jsxImportSource @opentui/react */
/**
 * The command screens (/resume, /automations, /status, /connect, the plan,
 * question and Auto-consent prompts), rendered headlessly and driven with real
 * keys. The session and the services are recording fakes: these tests pin what
 * each screen shows and what each key asks for.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { SessionState } from "../src/cli/agent/session";
import type { AutomationSummary, CliServices } from "../src/cli/agent/services";
import { App } from "../src/cli/tui/App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

type Call = [string, ...unknown[]];

class FakeSession extends EventEmitter {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-screens-ws-"));
  appId = 7;
  model = undefined;
  calls: Call[] = [];
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
    sessionTokens: 1234,
    cachedTokens: 1000,
    costUsd: 0,
    lastError: null,
    question: null,
    planReady: null,
    planRevision: 0,
    title: null,
    automationUnread: 0,
    mcpConsent: null,
  };
  set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.emit("change", this.state);
  }
  private rec(name: string, ...a: unknown[]) {
    this.calls.push([name, ...a]);
  }
  async submit(...a: unknown[]) { this.rec("submit", ...a); }
  queueNext(...a: unknown[]) { this.rec("queueNext", ...a); }
  popLastQueued() { return null; }
  setMode(m: string) { this.rec("setMode", m); this.set({ mode: m as SessionState["mode"] }); }
  async newSession() { this.rec("newSession"); }
  async interrupt() { this.rec("interrupt"); }
  async answerApproval(...a: unknown[]) { this.rec("answerApproval", ...a); }
  async runShell(...a: unknown[]) { this.rec("runShell", ...a); }
  stopShell: (() => void) | null = null;
  async listSessions() {
    return [
      { id: "s1", title: "Fix the login bug", updatedAt: new Date(Date.now() - 3_600_000), workMode: "build" },
      { id: "s2", title: "Plan the billing page", updatedAt: new Date(Date.now() - 86_400_000), workMode: "plan" },
    ];
  }
  async resume(id: string) { this.rec("resume", id); }
  async rename(t: string) { this.rec("rename", t); this.set({ title: t }); }
  async compact() { this.rec("compact"); return { ok: true, message: "Compacted · ~20k → ~3k tokens." }; }
  async plans() {
    return [{ id: "p1", title: "Add a health endpoint", status: "plan", content: "# Add a health endpoint\n- [ ] Add GET /health", createdAt: new Date() }];
  }
  async buildPlan(id: string) { this.rec("buildPlan", id); }
  async earlierPlans() {
    return [{ id: "p0", title: "Add billing", status: "built", content: "# Add billing\n- [x] Stripe", createdAt: new Date(Date.now() - 86_400_000), sessionTitle: "Billing work" }];
  }
  async buildEarlierPlan(id: string) { this.rec("buildEarlierPlan", id); }
  dismissPlanReady() { this.rec("dismissPlanReady"); this.set({ planReady: null }); }
  // As the real session: nothing to answer once the question is gone.
  async answerQuestion(a: string[]) { if (!this.state.question) return; this.rec("answerQuestion", a); this.set({ question: null }); }
  async answerMcpConsent(d: string) { if (!this.state.mcpConsent) return; this.rec("answerMcpConsent", d); this.set({ mcpConsent: null }); }
  dismissQuestion() { this.rec("dismissQuestion"); this.set({ question: null }); }
  async acceptAutoConsent() { this.rec("acceptAutoConsent"); }
  async subagentJobs() { return []; }
  async subagentOutput() { return ""; }
  async cancelSubagent() {}
  /** What /tasks lists; a test sets it. */
  tasks: Array<Record<string, unknown>> = [];
  async liveTasks() { return this.tasks; }
  async taskOutput(t: { id: string }) { return t.id === "cmd:j1" ? "compiled 12 files\nwatching for changes" : ""; }
  async stopTask(t: { id: string; label: string }) { this.rec("stopTask", t.id); this.tasks = this.tasks.filter((x) => x.id !== t.id); return `Stopped “${t.label}”.`; }
  async aside(q: string) { this.rec("aside", q); return "It uses SQLite, set up in db.ts."; }
  exportable() {
    return {
      title: "Explain the router",
      sessionId: "s9",
      model: undefined,
      messages: [
        { id: 1, role: "user", content: "explain the router" },
        { id: 2, role: "assistant", content: "It maps paths to handlers." },
      ],
    };
  }
  async importMessages(...a: unknown[]) { this.rec("importMessages", ...a); }
  markAutomationsRead() { this.rec("markAutomationsRead"); }
  myMessages() {
    return [
      { id: 30, text: "set v to 2" },
      { id: 10, text: "explain the router" },
    ];
  }
  async undoPreview(id: number) {
    return id === 30
      ? { turnIds: ["t30"], filesChanged: ["/w/src/v.ts"], createdFiles: [] }
      : { turnIds: [], filesChanged: [], createdFiles: [] };
  }
  async resendEdited(...a: unknown[]) { this.rec("resendEdited", ...a); return { restoredFiles: 1 }; }
}

function fakeServices(calls: Call[]): CliServices {
  const automations: AutomationSummary[] = [
    {
      id: "a1",
      workspaceId: 7,
      name: "Nightly tests",
      enabled: true,
      trigger: { kind: "schedule", cron: "0 9 * * *", preset: "daily" },
      prompt: "run the tests",
      runMode: "read-only",
      notifyAgent: false,
      model: null,
      lastRunAt: null,
    },
  ];
  const rec = (name: string) => async (...a: unknown[]) => void calls.push([name, ...a]);
  return {
    automations: {
      list: async () => automations,
      runs: async () => [],
      create: rec("automations.create"),
      update: rec("automations.update"),
      toggle: rec("automations.toggle"),
      remove: rec("automations.remove"),
      runNow: rec("automations.runNow"),
      markRead: rec("automations.markRead"),
    },
    mcp: (() => {
      const servers = [{ id: 1, name: "github", transport: "stdio", enabled: true }];
      return {
        list: async () => servers.map((x) => ({ ...x })),
        test: async () => ({ ok: true }),
        tools: async () => [],
        add: async (appId: number, server: { name: string; command?: string; url?: string }) => {
          calls.push(["mcp.add", appId, server]);
          servers.push({ id: servers.length + 1, name: server.name, transport: server.url ? "http" : "stdio", enabled: true });
        },
        setEnabled: async (id: number, on: boolean) => {
          calls.push(["mcp.setEnabled", id, on]);
          servers.find((x) => x.id === id)!.enabled = on;
        },
        remove: async (id: number) => {
          calls.push(["mcp.remove", id]);
          servers.splice(servers.findIndex((x) => x.id === id), 1);
        },
      };
    })(),
    permissions: { list: async () => [], revoke: rec("permissions.revoke") },
    providers: {
      list: async () => [
        { id: "anthropic", name: "Anthropic", hasKey: false, keyUrl: "https://console.anthropic.com" },
        { id: "openai", name: "OpenAI", hasKey: true },
      ],
      saveKey: rec("providers.saveKey"),
    },
    analytics: (() => {
      // Answered by default, so other tests aren't interrupted by the question.
      let consent: "opted_in" | "opted_out" | "unset" = "opted_out";
      return {
        consent: async () => consent,
        setConsent: async (v: "opted_in" | "opted_out") => {
          consent = v;
          calls.push(["analytics.setConsent", v]);
        },
        track: (event: string, props?: Record<string, unknown>) => void calls.push(["analytics.track", event, props]),
        __unset: () => void (consent = "unset"),
      };
    })(),
    account: {
      email: async () => "dev@example.com",
      balanceCents: async () => 1250,
      signOut: rec("account.signOut"),
      checkout: async (kind: string, cents?: number) => {
        calls.push(["account.checkout", kind, cents]);
        return "https://atlarix.lemonsqueezy.com/checkout/test";
      },
    },
    relics: {
      list: async () => [
        { id: "rl_1", title: "Billing page design", kind: "design", hosted: true, url: "https://atlarix.dev/r/rl_1", visibility: "private", updatedAt: Date.now() - 60_000 },
        { id: "local:report", title: "Perf report", kind: "page", hosted: false, path: "/w/.atlarix/relics/report/index.html", updatedAt: Date.now() - 3_600_000 },
      ],
      remove: rec("relics.remove"),
      setVisibility: rec("relics.setVisibility"),
    },
  };
}

let current: Awaited<ReturnType<typeof testRender>> | null = null;
afterEach(async () => {
  current?.renderer.destroy();
  current = null;
  await Bun.sleep(300);
});

/** Links the app tried to open: recorded, never sent to a real browser. */
const opened: string[] = [];

async function mount(adjust?: (services: CliServices) => void, models?: import("../src/cli/tui/App").ModelSource, ratingChance = 0) {
  const session = new FakeSession();
  const serviceCalls: Call[] = [];
  const services = fakeServices(serviceCalls);
  adjust?.(services);
  const setup = await testRender(
    <App session={session as never} modelLabel="Atlarix Auto" version="15.0.0" onQuit={() => {}} plainMarkdown services={services} models={models} chromeStatus={() => "connected"} openUrl={(u) => opened.push(u)} ratingChance={ratingChance} />,
    { width: 120, height: 40, exitOnCtrlC: false },
  );
  current = setup;
  await setup.renderOnce();
  return { setup, session, serviceCalls };
}

type Setup = Awaited<ReturnType<typeof testRender>>;

async function frameContaining(setup: Setup, text: string, ms = 4000) {
  const end = Date.now() + ms;
  let frame = "";
  while (Date.now() < end) {
    await Bun.sleep(40);
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    if (frame.includes(text)) return frame;
  }
  return frame;
}

async function until(pred: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) await Bun.sleep(30);
  return pred();
}

const settle = async (setup: Setup) => {
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(25);
    await setup.renderOnce();
  }
};

async function command(setup: Setup, line: string) {
  await setup.mockInput.typeText(line);
  await settle(setup);
  setup.mockInput.pressEnter();
  await settle(setup);
}

describe("command screens", () => {
  it("lists every working command in the palette", async () => {
    const { setup } = await mount();
    await setup.mockInput.typeText("/");
    const frame = await frameContaining(setup, "/model");
    expect(frame).toContain("/resume");
    expect(frame).toContain("/compact");
    // The palette shows 8 at a time; the rest are reached by typing.
    await setup.mockInput.typeText("au");
    expect(await frameContaining(setup, "/automations")).toContain("Scheduled and triggered");
  });

  it("/resume lists this folder's sessions and opens the chosen one", async () => {
    const { setup, session } = await mount();
    await command(setup, "/resume");
    const frame = await frameContaining(setup, "Fix the login bug");
    expect(frame).toContain("Resume a session");
    expect(frame).toContain("Plan the billing page");
    await setup.mockInput.typeText("billing");
    await settle(setup);
    setup.mockInput.pressEnter();
    expect(await until(() => session.calls.some((c) => c[0] === "resume"))).toBe(true);
    expect(session.calls.find((c) => c[0] === "resume")).toEqual(["resume", "s2"]);
    expect(await frameContaining(setup, "Resumed")).toContain("Plan the billing page");
  });

  it("a question from the agent opens by itself; a number answers it", async () => {
    const { setup, session } = await mount();
    session.set({ question: { questionId: "q1", items: [{ question: "Which database?", options: ["Postgres", "SQLite"] }] } });
    expect(await frameContaining(setup, "Which database?")).toContain("2. SQLite");
    setup.mockInput.pressKey("2");
    expect(await until(() => session.calls.some((c) => c[0] === "answerQuestion"))).toBe(true);
    expect(session.calls.find((c) => c[0] === "answerQuestion")).toEqual(["answerQuestion", ["SQLite"]]);
    expect(session.calls.some((c) => c[0] === "dismissQuestion")).toBe(false);
  });

  it("an MCP tool call waits for an OK; choosing answers it, esc refuses", async () => {
    const { setup, session } = await mount();
    session.set({ mcpConsent: { requestId: "r1", serverName: "GitHub", toolName: "create_issue", inputPreview: '{"title":"x"}' } });
    expect(await frameContaining(setup, "Allow create_issue?")).toContain("on GitHub");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    expect(await until(() => session.calls.some((c) => c[0] === "answerMcpConsent"))).toBe(true);
    expect(session.calls.filter((c) => c[0] === "answerMcpConsent")).toEqual([["answerMcpConsent", "accept-always"]]);

    session.set({ mcpConsent: { requestId: "r2", serverName: "GitHub", toolName: "delete_repo" } });
    await frameContaining(setup, "Allow delete_repo?");
    setup.mockInput.pressEscape();
    expect(await until(() => session.calls.some((c) => c[0] === "answerMcpConsent" && c[1] === "decline"))).toBe(true);
  });

  it("your own answer is typed right in the question, without leaving it", async () => {
    const { setup, session } = await mount();
    session.set({ question: { questionId: "q4", items: [{ question: "What next?", options: ["Tests", "Docs"] }] } });
    let frame = await frameContaining(setup, "What next?");
    expect(frame).toContain("Type your own answer…");
    await setup.mockInput.typeText("the chrome extension");
    frame = await frameContaining(setup, "the chrome extension");
    expect(frame).toContain("What next?"); // still the same dialog
    setup.mockInput.pressEnter();
    expect(await until(() => session.calls.some((c) => c[0] === "answerQuestion"))).toBe(true);
    expect(session.calls.find((c) => c[0] === "answerQuestion")).toEqual(["answerQuestion", ["the chrome extension"]]);
  });

  it("an edit shows what changed; an answered question shows as question and answer", async () => {
    const { setup, session } = await mount();
    session.set({
      cells: [
        { kind: "user", id: "u", text: "edit it" },
        {
          kind: "tool",
          id: "t",
          tool: {
            id: "e1",
            verb: "Edit",
            target: `${session.workspaceDir}/hello.md`,
            status: "success",
            summary: "+1 −1",
            diff: { added: 1, removed: 1, lines: [{ kind: "remove", text: "# Test file" }, { kind: "add", text: "# Test file (edited)" }] },
          },
        },
        { kind: "answers", id: "a", pairs: [{ question: "What do you want to do today?", answer: "try the chrome extension" }] },
      ],
    } as never);
    const frame = await frameContaining(setup, "Test file (edited)");
    expect(frame).toContain("◇ Edit hello.md  +1 −1"); // relative to the workspace
    expect(frame).toContain("− # Test file");
    expect(frame).toContain("+ # Test file (edited)");
    expect(frame).toContain("? What do you want to do today?");
    expect(frame).toContain("› try the chrome extension");
    expect(frame).not.toContain("***Q:***");
  });

  it("several questions end in a review: change one, then send them all", async () => {
    const { setup, session } = await mount();
    session.set({
      questionId: undefined,
      question: {
        questionId: "q3",
        items: [
          { question: "Which database?", options: ["Postgres", "SQLite"] },
          { question: "Add auth?", options: ["Yes", "No"] },
        ],
      },
    } as never);
    await frameContaining(setup, "Which database?");
    setup.mockInput.pressKey("1");
    await frameContaining(setup, "Add auth?");
    setup.mockInput.pressKey("2");
    let frame = await frameContaining(setup, "Send all answers");
    expect(frame).toContain("→ Postgres");
    expect(frame).toContain("→ No");
    expect(session.calls.some((c) => c[0] === "answerQuestion")).toBe(false);
    setup.mockInput.pressKey("1"); // change the first
    await frameContaining(setup, "Which database?");
    setup.mockInput.pressKey("2");
    frame = await frameContaining(setup, "→ SQLite");
    setup.mockInput.pressEnter(); // "Send all answers" is first
    expect(await until(() => session.calls.some((c) => c[0] === "answerQuestion"))).toBe(true);
    expect(session.calls.find((c) => c[0] === "answerQuestion")).toEqual(["answerQuestion", ["SQLite", "No"]]);
  });

  it("the strip shows what's running; ↓ picks one, enter opens its details, x stops it", async () => {
    const { setup, session } = await mount();
    session.tasks = [
      {
        id: "agent:d1",
        kind: "agent",
        label: "Find the export",
        elapsedMs: 65_000,
        stalled: false,
        tools: [{ id: "t1", verb: "Search", target: '"export const a"', status: "success", summary: "1 match" }],
        progress: "reading a.ts",
      },
      { id: "cmd:j1", kind: "command", label: "npm run dev", elapsedMs: 5_000, stalled: false, jobId: "j1", tools: [] },
    ];
    // UNDER the prompt box (owner, 2026-10-05): "main", then one row per
    // sub-agent with what it is doing and for how long; commands share a row.
    let frame = await frameContaining(setup, "Find the export");
    expect(frame).toContain("↓ tasks");
    expect(frame).toContain("● main");
    expect(frame).toContain('Search "export const a"');
    expect(frame).toContain("1m 05s");
    expect(frame).toContain("1 command");
    expect(frame).toContain("npm run dev");
    expect(frame).toContain("↓ to select");
    const lines = frame.split("\n");
    const boxBottom = lines.findIndex((l) => l.includes("↓ tasks"));
    expect(lines.findIndex((l) => l.includes("Find the export"))).toBeGreaterThan(boxBottom);
    // ↓ picks a row; enter opens that sub-agent's own view (live), esc backs out.
    setup.mockInput.pressArrow("down");
    frame = await frameContaining(setup, "enter open · x stop");
    setup.mockInput.pressEnter();
    frame = await frameContaining(setup, "Sub-agent 1/1");
    expect(frame).toContain("Find the export");
    expect(frame).toContain("Search");
    expect(frame).toContain("export const a");
    expect(frame).toContain("1 match");
    expect(frame).toContain("←→");
    setup.mockInput.pressEscape();
    expect(await until(() => !setup.captureCharFrame().includes("Sub-agent 1/1"))).toBe(true);
    // The command: its output, like Claude Code's Shell details.
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    await frameContaining(setup, "enter open · x stop");
    setup.mockInput.pressEnter();
    frame = await frameContaining(setup, "Command details");
    expect(frame).toContain("Command   npm run dev");
    expect(frame).toContain("compiled 12 files");
    expect(frame).toContain("Showing 2 lines");
    setup.mockInput.pressKey("x");
    expect(await until(() => session.calls.some((c) => c[0] === "stopTask"))).toBe(true);
    expect(session.calls.find((c) => c[0] === "stopTask")).toEqual(["stopTask", "cmd:j1"]);
  }, 20_000);

  it("/tasks lists what's running; enter opens one, x stops it", async () => {
    const { setup, session } = await mount();
    session.tasks = [{ id: "cmd:j1", kind: "command", label: "npm run dev", elapsedMs: 5_000, stalled: false, jobId: "j1", tools: [] }];
    await command(setup, "/tasks");
    const frame = await frameContaining(setup, "Background tasks");
    expect(frame).toContain("npm run dev");
    setup.mockInput.pressKey("x");
    expect(await until(() => session.calls.some((c) => c[0] === "stopTask"))).toBe(true);
  });

  it("/rename names the session, and the border shows the name", async () => {
    const { setup, session } = await mount();
    await command(setup, "/rename Fix B008 false positive");
    expect(await frameContaining(setup, "Renamed to")).toContain("Fix B008 false positive");
    expect(session.calls.find((c) => c[0] === "rename")).toEqual(["rename", "Fix B008 false positive"]);
    expect(await frameContaining(setup, "· Fix B008 false positive ·")).toBeTruthy();
  });

  it("/btw answers a side question without sending a message", async () => {
    const { setup, session } = await mount();
    await setup.mockInput.typeText("/btw which database do we use?");
    setup.mockInput.pressEnter();
    const frame = await frameContaining(setup, "set up in db.ts");
    expect(frame).toContain("By the way");
    expect(frame).toContain("Not saved");
    expect(session.calls.find((c) => c[0] === "aside")).toEqual(["aside", "which database do we use?"]);
    expect(session.calls.some((c) => c[0] === "submit")).toBe(false);
  });

  it("esc leaves the question unanswered", async () => {
    const { setup, session } = await mount();
    session.set({ question: { questionId: "q2", items: [{ question: "Proceed?", options: ["Yes", "No"] }] } });
    await frameContaining(setup, "Proceed?");
    setup.mockInput.pressEscape();
    expect(await until(() => session.calls.some((c) => c[0] === "dismissQuestion"))).toBe(true);
  });

  it("a finished plan is pinned above the box, readable, and /build builds it", async () => {
    const { setup, session } = await mount();
    session.set({ planReady: { planId: "p1", title: "Add a health endpoint" }, planRevision: 1 });
    // The plan itself, not a chooser over the conversation (owner, 2026-10-05).
    const frame = await frameContaining(setup, "Add GET /health");
    expect(frame).toContain("Plan · Add a health endpoint · ready to build");
    expect(frame).toContain("Build it");
    expect(frame).not.toContain("Keep planning");
    const lines = frame.split("\n");
    expect(lines.findIndex((l) => l.includes("Add GET /health"))).toBeLessThan(lines.findLastIndex((l) => l.includes("shift+tab mode")));
    // You can type in the box while it shows.
    await setup.mockInput.typeText("make step 1 more specific");
    expect(await frameContaining(setup, "make step 1 more specific")).toContain("Add GET /health");
    for (let i = 0; i < 30; i++) setup.mockInput.pressBackspace();
    // esc hides it; /plan brings it back; /build builds it.
    await frameContaining(setup, "Ask Atlarix");
    setup.mockInput.pressEscape();
    expect(await until(() => !setup.captureCharFrame().includes("Add GET /health"))).toBe(true);
    await command(setup, "/plan");
    await frameContaining(setup, "Add GET /health");
    await command(setup, "/build");
    expect(await until(() => session.calls.some((c) => c[0] === "buildPlan"))).toBe(true);
    expect(session.calls.find((c) => c[0] === "buildPlan")).toEqual(["buildPlan", "p1"]);
  });

  it("free Auto's consent: accepting it sends the message again", async () => {
    const { setup, session } = await mount();
    session.set({ lastError: "Atlarix Auto is free once you OK sharing its prompts with OpenAI to improve their models." });
    expect(await frameContaining(setup, "Use Atlarix Auto for free?")).toContain("shared with OpenAI");
    setup.mockInput.pressEnter();
    expect(await until(() => session.calls.some((c) => c[0] === "acceptAutoConsent"))).toBe(true);
  });

  it("/automations lists them, toggles one, and makes a new one step by step", async () => {
    const { setup, session, serviceCalls } = await mount();
    await command(setup, "/automations");
    const frame = await frameContaining(setup, "Nightly tests");
    expect(frame).toContain("daily (9am)");
    expect(frame).toContain("run while Atlarix (the app or this CLI) is open".slice(0, 20));
    expect(session.calls.some((c) => c[0] === "markAutomationsRead")).toBe(true);

    setup.mockInput.pressKey(" ");
    expect(await until(() => serviceCalls.some((c) => c[0] === "automations.toggle"))).toBe(true);
    expect(serviceCalls.find((c) => c[0] === "automations.toggle")).toEqual(["automations.toggle", "a1", false]);

    setup.mockInput.pressKey("n");
    await frameContaining(setup, "New automation");
    await setup.mockInput.typeText("Morning check");
    setup.mockInput.pressEnter();
    await frameContaining(setup, "When does it run?");
    setup.mockInput.pressArrow("down"); // Daily (9am)
    setup.mockInput.pressEnter();
    await frameContaining(setup, "When it fires");
    setup.mockInput.pressEnter(); // Atlarix runs a task
    await frameContaining(setup, "What should Atlarix do");
    await setup.mockInput.typeText("check the build");
    setup.mockInput.pressEnter();
    await frameContaining(setup, "who hears about it");
    setup.mockInput.pressEnter(); // Just me
    expect(await until(() => serviceCalls.some((c) => c[0] === "automations.create"))).toBe(true);
    const [, appId, draft] = serviceCalls.find((c) => c[0] === "automations.create")!;
    expect(appId).toBe(7);
    expect(draft).toMatchObject({
      name: "Morning check",
      trigger: { kind: "schedule", cron: "0 9 * * *" },
      runMode: "read-only",
      prompt: "check the build",
      notifyAgent: false,
    });
  });

  it("/automations: n starts a new one even when there are none yet", async () => {
    const { setup } = await mount((services) => (services.automations.list = async () => []));
    await command(setup, "/automations");
    await frameContaining(setup, "No automations for this folder");
    setup.mockInput.pressKey("n");
    expect(await frameContaining(setup, "New automation")).toContain("Name");
  });

  it("/status shows the account, balance, usage and Chrome", async () => {
    const { setup } = await mount();
    await command(setup, "/status");
    const frame = await frameContaining(setup, "dev@example.com");
    expect(frame).toContain("$12.50");
    expect(frame).toContain("1,234 tokens (1,000 from cache)");
    expect(frame).toContain("connected");
  });

  it("/model: ctrl+a connects a provider, and its key leads back to that provider's models", async () => {
    const chosen: unknown[] = [];
    const models = {
      load: async () => [
        { provider: "compass", name: "core-auto", label: "Atlarix Auto", providerName: "Atlarix", detail: "", deepThinking: false, free: true },
        { provider: "anthropic", name: "claude-x", label: "Claude X", providerName: "Anthropic", detail: "", deepThinking: false, context: "200K" },
      ],
      state: () => ({ recent: [], favorites: [] }),
      save: () => {},
      choose: (r: unknown) => chosen.push(r),
      setDeepThinking: () => {},
    };
    const { setup, serviceCalls } = await mount(undefined, models);
    await command(setup, "/model");
    let frame = await frameContaining(setup, "Connect provider");
    expect(frame).toContain("Free");
    expect(frame).toContain("200K");
    setup.mockInput.pressKey("a", { ctrl: true });
    frame = await frameContaining(setup, "Chrome extension");
    expect(frame).toContain("Popular");
    expect(frame).toContain("MCP server");
    await setup.mockInput.typeText("anthropic");
    await settle(setup);
    setup.mockInput.pressEnter();
    await frameContaining(setup, "Anthropic API key");
    await setup.mockInput.pasteBracketedText("sk-ant-secret-123456");
    setup.mockInput.pressEnter();
    expect(await until(() => serviceCalls.some((c) => c[0] === "providers.saveKey"))).toBe(true);
    frame = await frameContaining(setup, "Anthropic models");
    expect(frame).toContain("Claude X");
    expect(frame).not.toContain("Free"); // Atlarix Auto's row: only Anthropic's models are listed
  });

  it("/mcp: space turns a server off, a adds one, and the border counts what's on", async () => {
    const { setup, serviceCalls } = await mount();
    expect(await frameContaining(setup, "⊙ 1 MCP")).toContain("/commands");
    await command(setup, "/mcp");
    let frame = await frameContaining(setup, "MCP servers");
    expect(frame).toContain("github");
    expect(frame).toContain("✓ on");
    expect(frame).toContain("On/off space");
    setup.mockInput.pressKey(" ");
    frame = await frameContaining(setup, "○ off");
    expect(serviceCalls).toContainEqual(["mcp.setEnabled", 1, false]);
    setup.mockInput.pressKey("a");
    await frameContaining(setup, "Add an MCP server");
    await setup.mockInput.typeText("search");
    setup.mockInput.pressEnter();
    await frameContaining(setup, "Command or URL");
    await setup.mockInput.typeText("https://mcp.example.com/mcp");
    setup.mockInput.pressEnter();
    expect(await until(() => serviceCalls.some((c) => c[0] === "mcp.add"))).toBe(true);
    expect(serviceCalls.find((c) => c[0] === "mcp.add")![2]).toEqual({ name: "search", url: "https://mcp.example.com/mcp" });
    frame = await frameContaining(setup, "Added search");
    setup.mockInput.pressEscape();
    expect(await frameContaining(setup, "⊙ 1 MCP")).toBeTruthy(); // github off, search on
  });

  it("/chrome says it's connected; /connect lists it under Tools", async () => {
    const { setup } = await mount();
    await command(setup, "/chrome");
    const frame = await frameContaining(setup, "Chrome extension");
    expect(frame).toContain("✓ Connected");
    expect(frame).toContain("Open the store o");
  });

  it("ctrl+p lists every command; enter runs it", async () => {
    const { setup } = await mount();
    setup.mockInput.pressKey("p", { ctrl: true });
    let frame = await frameContaining(setup, "Commands");
    expect(frame).toContain("/model");
    expect(frame).not.toContain("/quit"); // aliases stay out of lists
    await setup.mockInput.typeText("chrome");
    await settle(setup);
    setup.mockInput.pressEnter();
    frame = await frameContaining(setup, "Chrome extension");
    expect(frame).toContain("Connected");
  });

  it("a message's attachments show as chips; a finished thought says how long it took; a turn ends with its footer", async () => {
    const { setup, session } = await mount();
    session.set({
      busy: false,
      cells: [
        { kind: "user", id: "1:u", text: "what's in [Image #1] and [Pasted text #1 +40 lines]", chips: ["[Image #1]", "[Pasted text #1 +40 lines]"] },
        { kind: "thought", id: "2:0", text: "**Reading the screenshot**\nIt shows a login form.", ms: 4200 },
        { kind: "markdown", id: "2:1", text: "A login form." },
        { kind: "footer", id: "2:footer", text: "Build · deepseek-flash · 12s" },
      ],
    } as never);
    const frame = await frameContaining(setup, "thought for 4s");
    expect(frame).toContain(" Image #1 ");
    expect(frame).toContain(" Pasted text #1 +40 lines ");
    expect(frame).toContain("∴ Reading the screenshot");
    expect(frame).not.toContain("**");
    expect(frame).toContain("◆ Build · deepseek-flash · 12s");
  });

  it("a toast shows a short message top-right, then goes", async () => {
    const { setup } = await mount();
    await command(setup, "/new");
    expect(await frameContaining(setup, "New session.")).toBeTruthy();
  });

  it("/billing shows the balance, and a top-up opens checkout with the link shown", async () => {
    const { setup, serviceCalls } = await mount();
    await command(setup, "/billing");
    let frame = await frameContaining(setup, "Plans and credit");
    expect(frame).toContain("$12.50");
    expect(frame).toContain("Get Atlarix Pro");
    expect(frame).toContain("Add $25 credit");
    for (let i = 0; i < 2; i++) setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    expect(await until(() => serviceCalls.some((c) => c[0] === "account.checkout"))).toBe(true);
    expect(serviceCalls.find((c) => c[0] === "account.checkout")).toEqual(["account.checkout", "credit", 1000]);
    frame = await frameContaining(setup, "Checkout is open in your browser");
    expect(frame).toContain("lemonsqueezy.com/checkout/test");
    expect(opened.at(-1)).toBe("https://atlarix.lemonsqueezy.com/checkout/test");
  });

  it("a failed turn over a limit says what happened and the way out", async () => {
    const { setup, session } = await mount();
    session.set({
      cells: [{ kind: "user", id: "1:u", text: "hi" }],
      lastError:
        "Sorry, there was an error from the AI: Your deepseek account is out of credit or over its quota, so it refused this request. Add credit on the provider's billing page, or switch model: Atlarix Auto is free. (It said: \"Insufficient Balance\")",
    } as never);
    const frame = await frameContaining(setup, "out of credit");
    expect(frame).toContain("⚠ Your deepseek account is out of credit or over its quota");
    expect(frame).toContain("It said: Insufficient Balance");
    expect(frame).toContain("/model switch (Atlarix Auto is free)");
  });

  it("the session rating: only with analytics on, after a real session, and it sends only the rating", async () => {
    const { setup, session, serviceCalls } = await mount((s) => void (s.analytics.consent = async () => "opted_in"), undefined, 1);
    for (let i = 0; i < 8; i++) {
      session.set({ busy: true, turnStartedAt: Date.now() });
      await settle(setup);
      session.set({ busy: false, turnStartedAt: null });
      await settle(setup);
      if (i < 7) expect(setup.captureCharFrame()).not.toContain("How is Atlarix doing");
    }
    const frame = await frameContaining(setup, "How is Atlarix doing this session?");
    expect(frame).toContain("1: Bad");
    expect(frame).toContain("0: Dismiss");
    setup.mockInput.pressKey("3");
    expect(await until(() => serviceCalls.some((c) => c[0] === "analytics.track" && c[1] === "cli_session_rating"))).toBe(true);
    const [, , props] = serviceCalls.find((c) => c[1] === "cli_session_rating")!;
    expect(props).toEqual({ rating: "good", mode: "build", model: "Atlarix Auto", turns: 8, version: "15.0.0" });
    expect(await until(() => !setup.captureCharFrame().includes("How is Atlarix doing"))).toBe(true);
    // The 3 was the answer, not typed into the box.
    expect(setup.captureCharFrame()).not.toMatch(/› 3/);
  });

  it("the session rating never appears with analytics off", async () => {
    const { setup, session } = await mount(undefined, undefined, 1);
    for (let i = 0; i < 9; i++) {
      session.set({ busy: true, turnStartedAt: Date.now() });
      await settle(setup);
      session.set({ busy: false, turnStartedAt: null });
      await settle(setup);
    }
    await Bun.sleep(100);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("How is Atlarix doing");
  });

  it("usage analytics: asked once on a first run, the answer saved; /analytics changes it later", async () => {
    const { setup, serviceCalls } = await mount((s) => (s.analytics as unknown as { __unset: () => void }).__unset());
    let frame = await frameContaining(setup, "Help improve Atlarix");
    expect(frame).toContain("Never your code, prompts, file names, or file contents");
    expect(frame).toContain("one answer covers both");
    setup.mockInput.pressEnter(); // "Yes, that's fine"
    expect(await until(() => serviceCalls.some((c) => c[0] === "analytics.setConsent"))).toBe(true);
    expect(serviceCalls.find((c) => c[0] === "analytics.setConsent")).toEqual(["analytics.setConsent", "opted_in"]);
    expect(await until(() => !setup.captureCharFrame().includes("Help improve Atlarix"))).toBe(true);
    await command(setup, "/analytics");
    frame = await frameContaining(setup, "Help improve Atlarix");
    setup.mockInput.pressArrow("down");
    await settle(setup);
    setup.mockInput.pressEnter(); // "No thanks"
    expect(await until(() => serviceCalls.filter((c) => c[0] === "analytics.setConsent").length === 2)).toBe(true);
    expect(serviceCalls.filter((c) => c[0] === "analytics.setConsent").at(-1)).toEqual(["analytics.setConsent", "opted_out"]);
    // Commands are counted by name only, never what followed them.
    expect(await until(() => !setup.captureCharFrame().includes("Help improve Atlarix"))).toBe(true);
    await command(setup, "/export notes.md");
    const tracked = serviceCalls.filter((c) => c[0] === "analytics.track" && c[1] === "cli_command").map((c) => c[2]);
    expect(tracked).toContainEqual({ command: "/export" });
    expect(JSON.stringify(tracked)).not.toContain("notes.md");
  });

  it("an answered question is never asked again", async () => {
    const { setup } = await mount();
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("Help improve Atlarix");
  });

  it("/connect saves a pasted key, shown masked", async () => {
    const { setup, serviceCalls } = await mount();
    await command(setup, "/connect");
    await frameContaining(setup, "Anthropic");
    await setup.mockInput.typeText("anthropic");
    await settle(setup);
    setup.mockInput.pressEnter();
    await frameContaining(setup, "Anthropic API key");
    await setup.mockInput.pasteBracketedText("sk-ant-secret-123456");
    const frame = await frameContaining(setup, "••••");
    expect(frame).not.toContain("sk-ant-secret");
    setup.mockInput.pressEnter();
    expect(await until(() => serviceCalls.some((c) => c[0] === "providers.saveKey"))).toBe(true);
    expect(serviceCalls.find((c) => c[0] === "providers.saveKey")).toEqual(["providers.saveKey", "anthropic", "sk-ant-secret-123456"]);
  });

  it("/export writes Markdown into the folder", async () => {
    const { setup, session } = await mount();
    await command(setup, "/export notes.md");
    await frameContaining(setup, "Exported to");
    const text = fs.readFileSync(path.join(session.workspaceDir, "notes.md"), "utf8");
    expect(text).toContain("# Explain the router");
    expect(text).toContain("## You\n\nexplain the router");
    expect(text).toContain("It maps paths to handlers.");
  });

  it("/compact reports what it did", async () => {
    const { setup } = await mount();
    await command(setup, "/compact");
    expect(await frameContaining(setup, "Compacted")).toContain("~3k tokens");
  });

  it("/compact typed mid-turn waits for the turn; messages sent after it still go in first", async () => {
    const { setup, session } = await mount();
    session.set({ busy: true, turnStartedAt: Date.now(), phase: "Thinking…" });
    await command(setup, "/compact");
    expect(await frameContaining(setup, "runs after this turn")).toContain("ctrl+s run now");
    expect(session.calls.some((c) => c[0] === "compact")).toBe(false);
    session.set({ busy: false, turnStartedAt: null, phase: null });
    expect(await until(() => session.calls.some((c) => c[0] === "compact"))).toBe(true);
    expect(await until(() => !setup.captureCharFrame().includes("runs after this turn"))).toBe(true);
  });

  it("/undo: restore the files, edit the message in the box, and send replaces it", async () => {
    const { setup, session } = await mount();
    await command(setup, "/undo");
    // /undo lets you choose which message, newest first (as esc esc does).
    const list = await frameContaining(setup, "Go back to a message");
    expect(list).toContain("explain the router");
    expect(list).toContain("latest");
    setup.mockInput.pressEnter(); // the latest
    const frame = await frameContaining(setup, "Go back to this message?");
    expect(frame).toContain("set v to 2");
    expect(frame).toContain("changed 1 file");
    setup.mockInput.pressEnter(); // Restore the files, then edit
    expect(await frameContaining(setup, "editing an earlier message")).toContain("restores 1 file");
    // The message is in the box to edit.
    expect(setup.captureCharFrame()).toContain("set v to 2");
    await setup.mockInput.typeText(" please");
    await settle(setup);
    setup.mockInput.pressEnter();
    expect(await until(() => session.calls.some((c) => c[0] === "resendEdited"))).toBe(true);
    expect(session.calls.find((c) => c[0] === "resendEdited")).toEqual(["resendEdited", 30, "set v to 2 please", ["t30"]]);
    expect(session.calls.some((c) => c[0] === "submit")).toBe(false);
  });

  it("ctrl+c cancels an edit and changes nothing", async () => {
    const { setup, session } = await mount();
    await command(setup, "/undo");
    await frameContaining(setup, "Go back to this message?");
    setup.mockInput.pressArrow("down"); // keep the files
    setup.mockInput.pressEnter();
    await frameContaining(setup, "editing an earlier message");
    setup.mockInput.pressCtrlC();
    expect(await frameContaining(setup, "Edit cancelled")).not.toContain("editing an earlier message");
    expect(session.calls.some((c) => c[0] === "resendEdited")).toBe(false);
  });

  it("esc esc on an empty box picks an earlier message to go back to", async () => {
    const { setup } = await mount();
    setup.mockInput.pressEscape();
    await Bun.sleep(100);
    setup.mockInput.pressEscape();
    const frame = await frameContaining(setup, "Go back to a message");
    expect(frame).toContain("set v to 2");
    expect(frame).toContain("explain the router");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    // No files changed after that one: straight to editing it.
    expect(await frameContaining(setup, "editing an earlier message")).toContain("explain the router");
  });

  it("/plan lists this session's plans and earlier sessions'; b builds an earlier one here", async () => {
    const { setup, session } = await mount();
    await command(setup, "/plan");
    const frame = await frameContaining(setup, "Earlier sessions");
    expect(frame).toContain("This session");
    expect(frame).toContain("Add a health endpoint");
    expect(frame).toContain("Billing work");
    // A plan opens as a document: its markdown, with its keys under it.
    setup.mockInput.pressEnter();
    const plan = await frameContaining(setup, "Add GET /health");
    expect(plan).toContain("build it");
    expect(plan).not.toContain("↑↓ scroll · b build it");
    setup.mockInput.pressEscape();
    await frameContaining(setup, "Earlier sessions");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    expect(await frameContaining(setup, "from “Billing work”")).toContain("build it in this session b");
    setup.mockInput.pressKey("b");
    expect(await until(() => session.calls.some((c) => c[0] === "buildEarlierPlan"))).toBe(true);
    expect(session.calls.find((c) => c[0] === "buildEarlierPlan")).toEqual(["buildEarlierPlan", "p0"]);
  });

  it("/relics lists hosted and local relics; s shares, d deletes after a second press", async () => {
    const { setup, serviceCalls } = await mount();
    await command(setup, "/relics");
    const frame = await frameContaining(setup, "Billing page design");
    expect(frame).toContain("private");
    expect(frame).toContain("Perf report");
    expect(frame).toContain("local");
    setup.mockInput.pressKey("s");
    expect(await until(() => serviceCalls.some((c) => c[0] === "relics.setVisibility"))).toBe(true);
    expect(serviceCalls.find((c) => c[0] === "relics.setVisibility")).toEqual(["relics.setVisibility", "rl_1", "link"]);
    setup.mockInput.pressKey("d");
    await frameContaining(setup, "Press d again");
    setup.mockInput.pressKey("d");
    expect(await until(() => serviceCalls.some((c) => c[0] === "relics.remove"))).toBe(true);
  });
});
