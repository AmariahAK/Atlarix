/**
 * Hooks, run for real: the person's hooks.json and installed plugins' hooks,
 * never a workspace's; only approved commands from verified plugins; deny-only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runPostToolUseHooks,
  runPreToolUseHooks,
  runPromptSubmitHooks,
  runSessionStartHooks,
  runStopHooks,
} from "@/lib/plugins/hooks";
import {
  commitPluginInstall,
  preparePluginInstall,
} from "@/lib/plugins/install";
import { pluginDir } from "@/lib/plugins/paths";
import { readPluginRecords, writePluginRecords } from "@/lib/plugins/store";

let home: string;
let work: string;
let ws: string;
let saved: string | undefined;

beforeEach(() => {
  home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-hooks-home-")),
  );
  work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-hooks-src-")),
  );
  ws = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-hooks-ws-")),
  );
  saved = process.env.ATLARIX_HOME_DIR;
  process.env.ATLARIX_HOME_DIR = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ATLARIX_HOME_DIR;
  else process.env.ATLARIX_HOME_DIR = saved;
  for (const d of [home, work, ws])
    fs.rmSync(d, { recursive: true, force: true });
});

const ctx = () => ({ workspacePath: ws, sessionId: "s1" });

function userHooks(hooks: unknown) {
  fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify({ hooks }));
}

function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

async function installClaudePlugin(
  hooks: unknown,
  extra: Record<string, string> = {},
) {
  const dir = path.join(work, "cc");
  write(dir, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "cc" }),
    "hooks/hooks.json": JSON.stringify({ hooks }),
    ...extra,
  });
  return commitPluginInstall(await preparePluginInstall(dir), {
    runnablesConfirmed: true,
  });
}

const run = {
  name: "run_command",
  args: { command: "rm -rf build", workspace: "x", _scopeChatId: 1 },
};

describe.runIf(process.platform !== "win32")("hooks", () => {
  it("an Atlarix pre_tool_use hook denies on any non-zero exit, with its output", async () => {
    userHooks([
      {
        event: "pre_tool_use",
        match: "run_command(rm *)",
        command: "echo no deletes >&2; exit 1",
      },
    ]);
    const d = await runPreToolUseHooks(ctx(), run.name, run.args);
    expect(d).toEqual({
      deniedBy: "hooks.json: echo no deletes >&2; exit 1",
      reason: "no deletes",
    });
    expect(
      await runPreToolUseHooks(ctx(), "run_command", { command: "ls" }),
    ).toBeNull();
  });

  it("a Claude Code hook denies on exit 2 or JSON deny, not on exit 1, and never approves", async () => {
    await installClaudePlugin({
      PreToolUse: [
        { matcher: "Read", hooks: [{ type: "command", command: "exit 1" }] },
        {
          matcher: "Grep",
          hooks: [
            {
              type: "command",
              command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'`,
            },
          ],
        },
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "echo blocked >&2; exit 2" }],
        },
        {
          matcher: "Edit|Write",
          hooks: [
            {
              type: "command",
              command: `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"frozen"}}'`,
            },
          ],
        },
      ],
    });
    expect(
      await runPreToolUseHooks(ctx(), "read_file", { path: "a" }),
    ).toBeNull();
    expect(
      await runPreToolUseHooks(ctx(), "grep", { pattern: "a" }),
    ).toBeNull();
    expect((await runPreToolUseHooks(ctx(), run.name, run.args))?.reason).toBe(
      "blocked",
    );
    expect(
      (await runPreToolUseHooks(ctx(), "edit_file", { path: "a" }))?.reason,
    ).toBe("frozen");
  });

  it("sends Claude Code's stdin shape, without the harness's own keys", async () => {
    const out = path.join(work, "stdin.json");
    await installClaudePlugin({
      PreToolUse: [
        {
          matcher: "Bash|Edit",
          hooks: [{ type: "command", command: `cat > "${out}"` }],
        },
      ],
    });
    await runPreToolUseHooks(ctx(), run.name, run.args);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({
      session_id: "s1",
      cwd: ws,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    });
    await runPreToolUseHooks(ctx(), "edit_file", { path: "src/a.ts" });
    expect(JSON.parse(fs.readFileSync(out, "utf8")).tool_input.file_path).toBe(
      path.join(ws, "src/a.ts"),
    );
  });

  it("finds a plugin's own script through ${CLAUDE_PLUGIN_ROOT}", async () => {
    await installClaudePlugin(
      {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "sh ${CLAUDE_PLUGIN_ROOT}/deny.sh" },
            ],
          },
        ],
      },
      { "deny.sh": "echo from-script >&2; exit 2\n" },
    );
    expect((await runPreToolUseHooks(ctx(), run.name, run.args))?.reason).toBe(
      "from-script",
    );
  });

  it("skips a plugin whose files changed since install", async () => {
    await installClaudePlugin(
      {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "sh ${CLAUDE_PLUGIN_ROOT}/deny.sh" },
            ],
          },
        ],
      },
      { "deny.sh": "exit 0\n" },
    );
    fs.writeFileSync(
      path.join(pluginDir("cc"), "deny.sh"),
      "echo tampered >&2; exit 2\n",
    );
    expect(await runPreToolUseHooks(ctx(), run.name, run.args)).toBeNull();
  });

  it("skips a command the person never approved", async () => {
    await installClaudePlugin({
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "exit 2" }] },
      ],
    });
    const [r] = readPluginRecords();
    writePluginRecords([{ ...r!, approvedHooks: [] }]);
    expect(await runPreToolUseHooks(ctx(), run.name, run.args)).toBeNull();
  });

  it("never runs a workspace's .atlarix hooks", async () => {
    write(ws, {
      ".atlarix/hooks.json": JSON.stringify({
        hooks: [{ event: "pre_tool_use", command: "exit 1" }],
      }),
      ".atlarix/hooks/hooks.json": JSON.stringify({
        hooks: [{ event: "pre_tool_use", command: "exit 1" }],
      }),
    });
    expect(await runPreToolUseHooks(ctx(), run.name, run.args)).toBeNull();
  });

  it("does not deny on a timeout", async () => {
    userHooks([
      { event: "pre_tool_use", command: "sleep 5; exit 1", timeoutMs: 200 },
    ]);
    expect(await runPreToolUseHooks(ctx(), run.name, run.args)).toBeNull();
  });

  it("stop hooks keep the turn going with their output", async () => {
    userHooks([{ event: "stop", command: "echo 2 tests failing; exit 1" }]);
    expect(await runStopHooks(ctx())).toMatch(
      /not done yet[\s\S]*2 tests failing/,
    );
    userHooks([{ event: "stop", command: "exit 0" }]);
    expect(await runStopHooks(ctx())).toBeNull();
  });

  it("prompt_submit adds context or stops the message; session_start adds context", async () => {
    userHooks([
      { event: "session_start", command: "echo branch is main" },
      { event: "prompt_submit", command: "echo ticket ABC-1" },
    ]);
    expect(await runSessionStartHooks(ctx())).toEqual(["branch is main"]);
    expect(await runPromptSubmitHooks(ctx(), "hi")).toEqual({
      blocked: null,
      context: ["ticket ABC-1"],
    });

    userHooks([
      {
        event: "prompt_submit",
        command: "grep -q secret && { echo no secrets >&2; exit 1; }; exit 0",
      },
    ]);
    expect((await runPromptSubmitHooks(ctx(), "my secret")).blocked).toMatch(
      /no secrets/,
    );
    expect((await runPromptSubmitHooks(ctx(), "fine")).blocked).toBeNull();
  });

  it("post_tool_use runs with the result", async () => {
    const out = path.join(work, "post.json");
    userHooks([
      {
        event: "post_tool_use",
        match: "run_command",
        command: `cat > "${out}"`,
      },
    ]);
    runPostToolUseHooks(ctx(), run.name, run.args, { exitCode: 0 });
    for (let i = 0; i < 50 && !fs.existsSync(out); i++)
      await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({
      event: "post_tool_use",
      tool: "run_command",
      args: { command: "rm -rf build" },
      result: { exitCode: 0 },
    });
  });
});
