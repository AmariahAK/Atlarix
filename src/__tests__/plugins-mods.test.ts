/**
 * Mods in the QuickJS isolate: only declared capabilities, limits that turn a
 * mod off, nothing of Node inside, reads inside the folder only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitPluginInstall,
  preparePluginInstall,
} from "@/lib/plugins/install";
import { paneRows } from "@/cli/tui/plugins";
import {
  MOD_EVENT_DEADLINE_MS,
  MOD_MEMORY_LIMIT_BYTES,
  _resetModsForTests,
  modCommands,
  modProblems,
  modsPromptSections,
  modsPromptSubmit,
  modsRenderPane,
  modsRunCommand,
  modsToolCall,
  modUiEvents,
  validTree,
  type ModUiEvent,
} from "@/lib/plugins/mod-host";
import { pluginDir } from "@/lib/plugins/paths";

let home: string;
let work: string;
let ws: string;
let saved: string | undefined;
let ui: ModUiEvent[];
const onUi = (e: ModUiEvent) => ui.push(e);

beforeEach(() => {
  home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-mods-home-")),
  );
  work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-mods-src-")),
  );
  ws = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-mods-ws-")),
  );
  saved = process.env.ATLARIX_HOME_DIR;
  process.env.ATLARIX_HOME_DIR = home;
  ui = [];
  modUiEvents.on("ui", onUi);
});
afterEach(() => {
  modUiEvents.off("ui", onUi);
  _resetModsForTests();
  if (saved === undefined) delete process.env.ATLARIX_HOME_DIR;
  else process.env.ATLARIX_HOME_DIR = saved;
  for (const d of [home, work, ws])
    fs.rmSync(d, { recursive: true, force: true });
});

const ctx = () => ({ workspacePath: ws, sessionId: "s1" });

async function installMod(source: string, capabilities: string[], name = "m") {
  const dir = path.join(work, name);
  fs.mkdirSync(path.join(dir, "mod"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "atlarix-silk.json"),
    JSON.stringify({ name, mod: { main: "mod/index.js", capabilities } }),
  );
  fs.writeFileSync(path.join(dir, "mod", "index.js"), source);
  const preview = await preparePluginInstall(dir);
  expect(preview.runnables).toContain(
    "mod mod/index.js: runs isolated (no files, network or programs), 32 MB, 200 ms per event",
  );
  for (const cap of capabilities) {
    expect(
      preview.runnables.some((r) => r.startsWith(`mod mod/index.js ${cap}: `)),
    ).toBe(true);
  }
  commitPluginInstall(preview, { runnablesConfirmed: true });
}

describe("mods", () => {
  it("deny a tool call when they declared `tool`", async () => {
    await installMod(
      `export function register(on, $) {
        on("tool.call", { tool: "run_command" }, (e) => e.args.command.startsWith("rm ") ? { deny: "no rm here" } : null);
      }`,
      ["tool"],
    );
    expect(
      await modsToolCall(ctx(), "run_command", {
        command: "rm -rf x",
        _scopeChatId: 1,
      }),
    ).toEqual({
      plugin: "m",
      reason: "no rm here",
    });
    expect(
      await modsToolCall(ctx(), "run_command", { command: "ls" }),
    ).toBeNull();
    expect(await modsToolCall(ctx(), "read_file", { path: "a" })).toBeNull();
  });

  it("get no events and no $ calls they did not declare", async () => {
    await installMod(
      `export function register(on, $) {
        on("tool.call", () => ({ deny: "should never run" }));
        on("session.start", () => { $.ui.toast("hi"); });
      }`,
      [],
    );
    expect(
      await modsToolCall(ctx(), "run_command", { command: "ls" }),
    ).toBeNull();
    const { modsSessionStart } = await import("@/lib/plugins/mod-host");
    await modsSessionStart(ctx());
    expect(ui).toEqual([]);
  });

  it("see nothing of Node, and cannot reach the host function", async () => {
    await installMod(
      `export function register(on, $) {
        on("command.run", () => ({ text: [typeof process, typeof require, typeof globalThis.__host, typeof fetch].join(",") }));
        $.command.register({ name: "probe", description: "x" });
      }`,
      ["command"],
    );
    expect(await modsRunCommand(ctx(), "/probe")).toBe(
      "undefined,undefined,undefined,undefined",
    );
  });

  it("are turned off, once and for good, when a call runs past its deadline", async () => {
    await installMod(
      `export function register(on) { on("tool.call", () => { for (;;) {} }); }`,
      ["tool"],
    );
    const t0 = Date.now();
    expect(
      await modsToolCall(ctx(), "run_command", { command: "ls" }),
    ).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(modProblems()[0]!.message).toMatch(
      /m's mod is off.*limits on tool.call/,
    );
    expect(ui).toContainEqual(
      expect.objectContaining({ kind: "off", plugin: "m" }),
    );
    // Not retried.
    const t1 = Date.now();
    await modsToolCall(ctx(), "run_command", { command: "ls" });
    expect(Date.now() - t1).toBeLessThan(150);
  });

  it("are turned off when they use too much memory", async () => {
    await installMod(
      `const hog = []; for (;;) hog.push("x".repeat(1 << 20));
       export function register() {}`,
      ["tool"],
    );
    expect(
      await modsToolCall(ctx(), "run_command", { command: "ls" }),
    ).toBeNull();
    expect(modProblems()[0]!.message).toMatch(/off/);
  });

  it("cannot import anything", async () => {
    await installMod(`import fs from "fs"; export function register() {}`, [
      "tool",
    ]);
    await modsToolCall(ctx(), "run_command", { command: "ls" });
    expect(modProblems()[0]!.message).toMatch(/failed to load/);
  });

  it("add context sections, labelled, and rewrite a prompt", async () => {
    await installMod(
      `export function register(on) {
        on("prompt.compose", () => ({ section: "Ticket ABC-1 is open." }));
        on("prompt.submit", (e) => ({ text: e.text + " (ABC-1)" }));
      }`,
      ["prompt"],
    );
    expect(await modsPromptSections(ctx())).toEqual([
      "From the m mod:\nTicket ABC-1 is open.",
    ]);
    expect(await modsPromptSubmit(ctx(), "fix it")).toBe("fix it (ABC-1)");
  });

  it("register commands and show status, toasts and panes", async () => {
    await installMod(
      `export function register(on, $) {
        $.command.register({ name: "count", description: "Count things" });
        on("command.run", { name: "count" }, (e) => {
          const n = ($.state.get("n") || 0) + 1;
          $.state.set("n", n);
          $.ui.status("count " + n);
          $.ui.open({ id: "p", title: "Counter" });
          return { text: "n=" + n + " " + e.args };
        });
        on("ui.render", { component: "Pane" }, () => ({ type: "Box", children: [{ type: "Text", props: { text: "hello" } }, { type: "Script", props: {} }] }));
      }`,
      ["command", "ui", "state"],
    );
    expect((await modCommands(ctx())).map((c) => c.name)).toEqual(["count"]);
    expect(await modsRunCommand(ctx(), "/count a")).toBe("n=1 a");
    expect(await modsRunCommand(ctx(), "/count b")).toBe("n=2 b");
    expect(ui).toContainEqual({ kind: "status", plugin: "m", text: "count 2" });
    expect(ui).toContainEqual({
      kind: "open",
      plugin: "m",
      id: "p",
      title: "Counter",
    });
    expect(await modsRenderPane(ctx(), "m", "p")).toEqual({
      type: "Box",
      props: {},
      children: [{ type: "Text", props: { text: "hello" } }],
    });
  });

  it("read files inside the open folder only", async () => {
    fs.writeFileSync(path.join(ws, "notes.txt"), "inside");
    fs.writeFileSync(path.join(work, "secret.txt"), "outside");
    fs.symlinkSync(path.join(work, "secret.txt"), path.join(ws, "link.txt"));
    await installMod(
      `export function register(on, $) {
        $.command.register({ name: "read" });
        on("command.run", (e) => { try { return { text: $.fs.read(e.args) }; } catch (err) { return { text: "refused: " + err.message }; } });
      }`,
      ["command", "fs"],
    );
    expect(await modsRunCommand(ctx(), "/read notes.txt")).toBe("inside");
    expect(
      await modsRunCommand(
        ctx(),
        "/read ../" + path.basename(work) + "/secret.txt",
      ),
    ).toMatch(/^refused/);
    expect(await modsRunCommand(ctx(), "/read link.txt")).toMatch(/^refused/);
  });

  it("are bounded in what they add to a turn", async () => {
    await installMod(
      `export function register(on) {
        for (let i = 0; i < 20; i++) on("prompt.compose", () => ({ section: "x".repeat(10000) }));
        on("prompt.submit", () => ({ text: "y".repeat(1e6) }));
      }`,
      ["prompt"],
    );
    const sections = await modsPromptSections(ctx());
    expect(sections).toHaveLength(5);
    expect(sections[0]!.length).toBeLessThan(4100);
    expect((await modsPromptSubmit(ctx(), "hi")).length).toBe(100_000);
  });

  it("read the folder of the chat that asked, with two chats at once", async () => {
    const other = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-mods-ws2-")),
    );
    try {
      fs.writeFileSync(path.join(ws, "who.txt"), "first");
      fs.writeFileSync(path.join(other, "who.txt"), "second");
      await installMod(
        `export function register(on, $) {
          $.command.register({ name: "who" });
          on("command.run", () => ({ text: $.fs.read("who.txt") }));
        }`,
        ["command", "fs"],
      );
      const [a, b] = await Promise.all([
        modsRunCommand({ workspacePath: ws }, "/who"),
        modsRunCommand({ workspacePath: other }, "/who"),
      ]);
      expect([a, b]).toEqual(["first", "second"]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("do not load once their files change", async () => {
    await installMod(
      `export function register(on) { on("tool.call", () => ({ deny: "v1" })); }`,
      ["tool"],
    );
    expect((await modsToolCall(ctx(), "x", {}))?.reason).toBe("v1");
    fs.writeFileSync(
      path.join(pluginDir("m"), "mod", "index.js"),
      `export function register(on) { on("tool.call", () => ({ deny: "tampered" })); }`,
    );
    expect(await modsToolCall(ctx(), "x", {})).toBeNull();
  });
});

describe("pane trees", () => {
  it("keep only the four element types and their known props", () => {
    expect(
      validTree({
        type: "Box",
        props: { direction: "row", onClick: "x" },
        children: [
          { type: "Button", props: { text: "Go", action: "go", html: "<b>" } },
          { type: "iframe" },
        ],
      }),
    ).toEqual({
      type: "Box",
      props: { direction: "row" },
      children: [{ type: "Button", props: { text: "Go", action: "go" } }],
    });
    expect(validTree({ type: "Nope" })).toBeNull();
  });
});

describe("what the confirm and the CLI say", () => {
  it("state the limits the host enforces", () => {
    expect(MOD_MEMORY_LIMIT_BYTES).toBe(32 * 1024 * 1024);
    expect(MOD_EVENT_DEADLINE_MS).toBe(200);
  });

  it("draw a pane in the CLI as text rows with pressable buttons", () => {
    expect(
      paneRows({
        type: "Box",
        children: [
          { type: "Text", props: { text: "2 open\n1 closed" } },
          { type: "Button", props: { text: "Refresh", action: "refresh" } },
        ],
      }),
    ).toEqual([
      { id: "text:0", label: "2 open", header: true },
      { id: "text:1", label: "1 closed", header: true },
      { id: "action:refresh", label: "[ Refresh ]" },
    ]);
  });
});
