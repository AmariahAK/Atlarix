import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_TURN_TIMEOUT_MS,
  setupEvalContext,
  runTurn,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { autoApproveDuring } from "../infra/auto-approve";
import { captureModelPatch } from "./swebench-runner";

/**
 * CI-safe proof that the SWE-bench runner mechanics work end-to-end WITHOUT a
 * real model or network: existing-repo workspace + unattended auto-approve +
 * `git diff` patch capture. The model is the scripted fake-LLM emitting one
 * write_file +.
 */
let ctx: EvalContext;
let repoDir: string;
let baseCommit: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
}

beforeAll(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-swebench-smoke-"));
  git(["init", "-q"]);
  git(["config", "user.email", "eval@atlarix.dev"]);
  git(["config", "user.name", "eval"]);
  fs.writeFileSync(
    path.join(repoDir, "buggy.py"),
    "def add(a, b):\n    return a - b\n",
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  baseCommit = git(["rev-parse", "HEAD"]).trim();

  ctx = await setupEvalContext({ workspaceDir: repoDir });
});

afterAll(async () => {
  await ctx.cleanup();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe("swebench runner mechanics (no network)", () => {
  it("auto-approves the edit and captures a non-empty patch", async () => {
    ctx.server.register(
      scenario("swe-smoke")
        // Read-before-edit (v14.23.0): overwriting an EXISTING file is refused without a
        // read. This mirrors what a real agent must now do on this benchmark, so the
        // smoke test exercises the same sequence rather than a shortcut the app rejects.
        .toolCall("read_file", { path: "buggy.py" })
        .toolCall("edit_file", {
          path: "buggy.py",
          content: "def add(a, b):\n    return a + b\n",
          operation: "write",
          description: "fix the add bug",
        })
        .text("Fixed the bug.")
        .build(),
    );

    const chatId = await ctx.newChat();
    await runTurn(ctx, {
      chatId,
      prompt:
        "sc=swe-smoke The add() function subtracts instead of adding. Fix it.",
      mode: "build",
      timeoutMs: AGENT_TURN_TIMEOUT_MS,
      during: autoApproveDuring(chatId, { timeoutMs: AGENT_TURN_TIMEOUT_MS }),
    });

    const patch = captureModelPatch(repoDir, baseCommit);
    expect(patch).toContain("buggy.py");
    expect(patch).toContain("return a + b");
  }, 60_000);
});
