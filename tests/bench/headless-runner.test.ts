import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setupEvalContext,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { runHeadlessAgent } from "@/headless/headless-runner";
import {
  registerModelsDevReasoning,
  __resetReasoningRegistryForTests,
} from "@/lib/routing/model-reasoning-profile";

/**
 * Proves the prod headless runner (`runHeadlessAgent`) drives the real loop +
 * unattended auto-approve + completion — in-process, no network. Electron is
 * mocked by the agent-evals project, so we inject `getIpcHandler` as the handler
 * resolver (the standalone bundle uses the electron-stub's registry instead).
 */
let ctx: EvalContext;
let wsDir: string;

beforeAll(async () => {
  ctx = await setupEvalContext();
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-hl-ws-"));
});

afterAll(async () => {
  __resetReasoningRegistryForTests();
  await ctx.cleanup();
  fs.rmSync(wsDir, { recursive: true, force: true });
  // runHeadlessAgent sets these process-wide — clear them so they don't leak
  // into other agent-eval files (e.g. toolset-golden expects browser tools).
  delete process.env.ATLARIX_HEADLESS;
  delete process.env.ATLARIX_DISABLE_TEXT_TOOLS;
  delete process.env.ATLARIX_USER_DATA_DIR;
  delete process.env.ATLARIX_OPENROUTER_PROVIDER_JSON;
});

describe("headless runner (in-process, no network)", () => {
  it("runs the real loop, auto-approves a write, and completes", async () => {
    ctx.server.register(
      scenario("hl-smoke")
        .toolCall("edit_file", {
          path: "out.txt",
          content: "hello from headless\n",
          operation: "write",
          description: "create out.txt",
        })
        .text("Done.")
        .build(),
    );

    const res = await runHeadlessAgent({
      workspaceDir: wsDir,
      prompt: "sc=hl-smoke create out.txt",
      provider: { baseUrl: ctx.server.baseURL, model: "hl-model" },
      mode: "build",
      timeoutMs: 30_000,
      resolveHandler: (channel) => getIpcHandler(channel),
    });

    expect(res.completed).toBe(true);
    expect(fs.existsSync(path.join(wsDir, "out.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, "out.txt"), "utf8")).toContain(
      "hello from headless",
    );

    // Headless integrity: the autonomous surface drops tools that can't work or
    // are harmful with no human/UI in the loop, and a real tool still executed
    // (native FC). See resolve-toolset.ts HEADLESS_DROP + browser_* filter.
    const requests = ctx.server.requestsFor("hl-smoke") as Array<{
      tools?: Array<{ function?: { name?: string }; name?: string }>;
    }>;
    const offered = (requests[0]?.tools ?? []).map(
      (t) => t.function?.name ?? t.name ?? "",
    );
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.some((n) => n.startsWith("browser_"))).toBe(false);
    // ask_user (false-success deadlock), MCP, and the web/attachment tools must
    // NOT be offered headless.
    for (const dropped of [
      "ask_user",
      "mcp_call",
      "list_available_mcps",
      "web_search",
      "read_url",
      "read_attachment",
      "list_attachments",
    ]) {
      expect(offered).not.toContain(dropped);
    }
    // run_command (and other core workspace tools) MUST still be offered.
    expect(offered).toContain("run_command");
  }, 60_000);
});

/**
 * The reasoning LEVEL a benchmark run dispatches at.
 *
 * `runHeadlessAgent` writes user-settings.json itself and never wrote
 * `deepThinking` — which is `z.boolean().optional()` with no default, so every
 * headless run resolved to OFF: one notch BELOW the model's declared ceiling.
 * Every published Terminal-Bench entry runs the ceiling (`reasoning_effort=max`),
 * so the harness was measured a level down from everything it was compared to.
 * That is a confound in the number, not a bug the agent loop can show you.
 *
 * Asserted on the BYTES the provider receives, not on the setting being stored —
 * a stored setting is what the previous tests in this area already proved, and it
 * proved nothing about the request. Same reason `reasoning-on-the-wire.eval` exists.
 */
describe("headless reasoning level reaches the provider", () => {
  const model = "hl-model";

  beforeAll(() => {
    // Declares an effort channel of ["high","max"], the shape deepseek-v4-flash
    // and the other open-weight vendors expose. The seeded headless provider is
    // OpenAI-compatible, which is the route those vendors take.
    registerModelsDevReasoning([
      {
        providerId: "atlarix-headless",
        modelId: model,
        profile: {
          reasoning: true,
          options: [{ type: "effort", values: ["high", "max"] }],
        },
        supportsTemperature: true,
      },
    ]);
  });

  async function runWith(deepThinking: boolean, sc: string) {
    ctx.server.register(scenario(sc).text("ok done.").build());
    const res = await runHeadlessAgent({
      workspaceDir: wsDir,
      prompt: `sc=${sc} hello`,
      provider: { baseUrl: ctx.server.baseURL, model },
      mode: "ask",
      timeoutMs: 30_000,
      deepThinking,
      resolveHandler: (channel) => getIpcHandler(channel),
    });
    expect(res.completed).toBe(true);
    const body = (
      ctx.server.requestsFor(sc) as Array<Record<string, unknown>>
    )[0];
    expect(body).toBeDefined();
    return body;
  }

  it("deepThinking:true dispatches the model's declared ceiling", async () => {
    const body = await runWith(true, "hl-reasoning-on");
    expect(body.reasoning_effort).toBe("max");
  }, 60_000);

  it("deepThinking:false dispatches one notch below it — the old silent default", async () => {
    const body = await runWith(false, "hl-reasoning-off");
    // The model declared ["high","max"], so OFF is "high" — never a level it did
    // not list, and never the same value as ON.
    expect(body.reasoning_effort).toBe("high");
  }, 60_000);
});

/**
 * The trajectory a benchmark harness reads back. Asserted from a REAL run through
 * the agent loop rather than from synthesised events (that is what
 * `src/__tests__/headless-trajectory-writer.test.ts` covers), because the thing
 * most likely to break is the shape of what the loop actually emits — the writer
 * reads live IPC payloads whose fields nothing else pins.
 */
describe("headless run writes a usable trajectory", () => {
  it("records the tool call, its args and result, and the run's token totals", async () => {
    ctx.server.register(
      scenario("hl-traj")
        .toolCall("edit_file", {
          path: "traj.txt",
          content: "written\n",
          operation: "write",
          description: "create traj.txt",
        })
        // Report real usage: `turnTokens` is only populated from a provider's own
        // figures, and it is what a leaderboard's token and cost columns read. A
        // scenario that reports none would let this test pass while the field the
        // harness actually consumes stayed empty.
        .text("All done.", {
          prompt_tokens: 900,
          completion_tokens: 120,
          total_tokens: 1020,
        })
        .build(),
    );

    const trajectoryFile = path.join(wsDir, "trajectory.jsonl");
    const res = await runHeadlessAgent({
      workspaceDir: wsDir,
      prompt: "sc=hl-traj create traj.txt",
      provider: { baseUrl: ctx.server.baseURL, model: "hl-model" },
      mode: "build",
      timeoutMs: 30_000,
      trajectoryFile,
      resolveHandler: (channel) => getIpcHandler(channel),
    });
    expect(res.completed).toBe(true);

    // Line-oriented, the way the Harbor adapter must read it.
    const lines = fs
      .readFileSync(trajectoryFile, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);

    expect(lines[0]).toMatchObject({ type: "run_start", schemaVersion: 1 });
    expect(lines.find((l) => l.type === "user_text")?.text).toContain(
      "create traj.txt",
    );

    // The real payload from build-branch.ts, not a synthesised one: if the
    // activity event ever stops carrying toolArgs, every trajectory silently
    // loses what the agent actually did and this is what says so.
    const tool = lines.find(
      (l) => l.type === "tool_use" && l.status !== "running",
    );
    expect(tool?.toolName).toBe("edit_file");
    expect(tool?.args?.path).toBe("traj.txt");
    expect(typeof tool?.toolCallId).toBe("string");

    const end = lines.find((l) => l.type === "turn_end");
    expect(end).toBeDefined();
    // `turnTokens` feeds the cost/token columns a leaderboard row reports.
    expect(typeof end?.turnTokens).toBe("number");
    expect(end?.turnTokens).toBeGreaterThan(0);

    expect(lines.at(-1)).toMatchObject({ type: "run_end", completed: true });
    // Assistant prose is summarised once, after the turn stops growing — never
    // once per chunk.
    expect(
      lines.filter((l) => l.type === "assistant_text").length,
    ).toBeLessThanOrEqual(1);
  }, 60_000);

  it("captures a command's OUTPUT, not just that it ran", async () => {
    // Commands are permission-gated, and that branch of build-branch.ts returned
    // without recording its result — so the completion event carried no
    // `resultText` and a trajectory showed commands with no output at all. A
    // leaderboard's reward-hacking judge audits trajectories by reading what the
    // agent did; "ran pytest" with no output is materially weaker evidence than
    // "ran pytest, saw 3 passed". Asserted end-to-end through the real loop.
    ctx.server.register(
      scenario("hl-cmd-output")
        .toolCall("run_command", {
          command: "echo atlarix-output-marker",
          description: "echo a marker",
        })
        .text("Ran it.")
        .build(),
    );

    const trajectoryFile = path.join(wsDir, "cmd-traj.jsonl");
    const res = await runHeadlessAgent({
      workspaceDir: wsDir,
      prompt: "sc=hl-cmd-output run the echo",
      provider: { baseUrl: ctx.server.baseURL, model: "hl-model" },
      mode: "build",
      timeoutMs: 30_000,
      trajectoryFile,
      resolveHandler: (channel) => getIpcHandler(channel),
    });
    expect(res.completed).toBe(true);

    const lines = fs
      .readFileSync(trajectoryFile, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);

    const done = lines.filter(
      (l) =>
        l.type === "tool_use" &&
        l.toolName === "run_command" &&
        l.status !== "running",
    );
    expect(done.length).toBeGreaterThan(0);
    const withResult = done.find(
      (l) => typeof l.resultText === "string" && l.resultText,
    );
    expect(withResult).toBeDefined();
    expect(withResult!.resultText).toContain("atlarix-output-marker");
  }, 60_000);

  it("runs to completion with no timeout supplied at all", async () => {
    // The default is now "no self-imposed deadline" — the launcher owns it. That
    // default reaches `waitFor` as Infinity, and `setTimeout` CLAMPS any delay
    // outside 1..2147483647 down to 1ms: handed straight to a timer it would fire
    // on the next tick and every run would report an instant timeout. Nothing else
    // covers this path, because every other caller passes an explicit timeoutMs.
    ctx.server.register(scenario("hl-no-timeout").text("done.").build());
    const res = await runHeadlessAgent({
      workspaceDir: wsDir,
      prompt: "sc=hl-no-timeout hello",
      provider: { baseUrl: ctx.server.baseURL, model: "hl-model" },
      mode: "ask",
      resolveHandler: (channel) => getIpcHandler(channel),
    });
    expect(res.completed).toBe(true);
  }, 60_000);

  it("writes nothing anywhere when no trajectory file is asked for", async () => {
    ctx.server.register(scenario("hl-no-traj").text("ok.").build());
    const before = fs.readdirSync(wsDir);
    await runHeadlessAgent({
      workspaceDir: wsDir,
      prompt: "sc=hl-no-traj hello",
      provider: { baseUrl: ctx.server.baseURL, model: "hl-model" },
      mode: "ask",
      timeoutMs: 30_000,
      resolveHandler: (channel) => getIpcHandler(channel),
    });
    expect(fs.readdirSync(wsDir).sort()).toEqual(before.sort());
  }, 60_000);
});
