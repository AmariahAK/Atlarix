/**
 * Computer use (15.11): which model gets which tool, how both tools' calls reach
 * the one executor, and the fallback that keeps a refused native tool from
 * costing the user a turn.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.fn(() => ({ computerUseModels: [] as string[] }));
const write = vi.fn();
vi.mock("@/main/settings", () => ({ readSettings: settings, writeSettings: write }));
vi.mock("../main/settings", () => ({ readSettings: settings, writeSettings: write }));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cu-test-"));
vi.mock("@/paths/paths", async (orig) => ({
  ...(await orig<object>()),
  getUserDataPath: () => userData,
}));

const { stepsForAnthropic, stepsForOpenAI } = await import("@/lib/computer/actions");
const { normaliseModelId, flaggedIds, __setCatalogIdsForTests } = await import("@/lib/computer/catalog");
const { computerLane, computerUseIneligible, __resetComputerLaneForTests, rememberNativeRejected } = await import(
  "@/lib/computer/lane"
);
const { registerModelsDevVision } = await import("@/lib/routing/model-capability-profile");
const { rememberCustomProviderFormats } = await import("@/lib/routing/custom-provider-format");
const { isNativeComputerToolRejection } = await import("@/ipc/handlers/chat_stream/network-retry");
const snapshot = (await import("@/lib/computer/computer-use-models.json")).default as { ids: string[] };

afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

/**
 * The Anthropic API's real 400 for Claude Haiku 5.5 sent `computer_20251124`
 * (captured 2026-10-23, request req_011CgK7hwAaJLZatGJqfftN3), in the shape the
 * AI SDK's APICallError carries it.
 */
const ANTHROPIC_400 = Object.assign(new Error("'claude-haiku-5-5' does not support tool types: computer_20251124. Did you mean one of bash_20250124, bash_code_execution_20250825, browser_toolset_20260801, code_execution_20250522, code_execution_20250825, code_execution_20260120, code_execution_20260521, computer_toolset_20260801, memory_20250818, python_with_tools_code_execution_20250825, python_with_tools_code_execution_20260120, python_with_tools_code_execution_20260521, text_editor_20250728, text_editor_code_execution_20250825, tool_search_tool_bm25_20251119, tool_search_tool_regex_20251119, web_fetch_20250910, web_fetch_20260209, web_fetch_20260309, web_fetch_20260318, web_search_20250305, web_search_20260209, web_search_20260318?"), {
  name: "AI_APICallError",
  statusCode: 400,
  responseBody: "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"'claude-haiku-5-5' does not support tool types: computer_20251124. Did you mean one of bash_20250124, bash_code_execution_20250825, browser_toolset_20260801, code_execution_20250522, code_execution_20250825, code_execution_20260120, code_execution_20260521, computer_toolset_20260801, memory_20250818, python_with_tools_code_execution_20250825, python_with_tools_code_execution_20260120, python_with_tools_code_execution_20260521, text_editor_20250728, text_editor_code_execution_20250825, tool_search_tool_bm25_20251119, tool_search_tool_regex_20251119, web_fetch_20250910, web_fetch_20260209, web_fetch_20260309, web_fetch_20260318, web_search_20250305, web_search_20260209, web_search_20260318?\"},\"request_id\":\"req_011CgK7hwAaJLZatGJqfftN3\"}",
});

function on(...keys: string[]) {
  settings.mockReturnValue({ computerUseModels: keys });
}

describe("actions → executor steps", () => {
  it("passes Anthropic's shape through: our tool and the native Anthropic tool share it", () => {
    expect(stepsForAnthropic({ action: "double_click", coordinate: [10, 20] })).toEqual([
      { op: "click", args: { x: 10, y: 20, button: "left", count: 2 } },
    ]);
    expect(stepsForAnthropic({ action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] })).toEqual([
      { op: "drag", args: { x: 1, y: 2, to_x: 3, to_y: 4 } },
    ]);
    expect(stepsForAnthropic({ action: "scroll", coordinate: [5, 6], scroll_direction: "up", scroll_amount: 2 })).toEqual([
      { op: "scroll", args: { x: 5, y: 6, dy: -2 } },
    ]);
    expect(stepsForAnthropic({ action: "key", text: "ctrl+s" })).toEqual([{ op: "key", args: { combo: "ctrl+s" } }]);
    expect(stepsForAnthropic({ action: "screenshot" })).toEqual([]);
  });

  it("refuses what it cannot do instead of doing something else", () => {
    expect(() => stepsForAnthropic({ action: "zoom" })).toThrow(/unknown action/);
    expect(() => stepsForAnthropic({ action: "left_click", coordinate: [1, 2], text: "shift" })).toThrow(/holding keys/);
    expect(() => stepsForAnthropic({ action: "type" })).toThrow(/needs text/);
    expect(() => stepsForAnthropic({ action: "mouse_move", coordinate: [1] as never })).toThrow(/\[x, y\]/);
  });

  it("translates OpenAI's batch, in order, pixels to wheel notches", () => {
    expect(
      stepsForOpenAI([
        { type: "click", button: "wheel", x: 1, y: 2 },
        { type: "keypress", keys: ["CTRL", "L"] },
        { type: "scroll", x: 3, y: 4, scrollX: 0, scrollY: 250 },
        { type: "drag", path: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 9 }] },
        { type: "screenshot" },
      ]),
    ).toEqual([
      { op: "click", args: { x: 1, y: 2, button: "middle", count: 1 } },
      { op: "key", args: { combo: "CTRL+L" } },
      { op: "scroll", args: { x: 3, y: 4, dx: 0, dy: 3 } },
      { op: "drag", args: { x: 0, y: 0, to_x: 9, to_y: 9 } },
    ]);
    expect(() => stepsForOpenAI([{ type: "click", button: "back", x: 1, y: 1 }])).toThrow(/not supported/);
  });
});

describe("LiteLLM catalog ids", () => {
  it("names a model one way however a provider spells it", () => {
    for (const raw of [
      "bedrock_converse/us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "vertex_ai/claude-haiku-4-5@20251001",
      "claude-haiku-4.5",
      "anthropic.claude-haiku-4-5-20251001-v1:0",
      "us-gov.anthropic.claude-haiku-4-5",
    ]) {
      expect(normaliseModelId(raw), raw).toBe("claude-haiku-4-5");
    }
    expect(normaliseModelId("azure/gpt-6-sol-2026-09-22")).toBe("gpt-6-sol");
    expect(normaliseModelId("gpt-6.1-sol")).toBe("gpt-6-1-sol");
  });

  it("keeps only flagged rows", () => {
    expect(
      flaggedIds({
        "claude-x": { supports_computer_use: true },
        "gpt-y": { supports_computer_use: false },
        sample_spec: { supports_computer_use: "yes" },
      }),
    ).toEqual(["claude-x"]);
  });

  it("ships a snapshot already in normal form (the script and the app agree)", () => {
    expect(snapshot.ids.length).toBeGreaterThan(10);
    for (const id of snapshot.ids) expect(normaliseModelId(id)).toBe(id);
  });
});

describe("computerLane", () => {
  beforeEach(() => {
    __resetComputerLaneForTests();
    fs.rmSync(path.join(userData, "cache"), { recursive: true, force: true });
    __setCatalogIdsForTests(["claude-haiku-4-5", "gpt-6-sol", "gemini-2.5-computer-use-preview-10-2025"]);
    rememberCustomProviderFormats([
      { id: "custom::bedrock", apiFormat: "anthropic" },
      { id: "custom::zai", apiFormat: "anthropic" },
    ]);
    registerModelsDevVision([
      { providerId: "zai", modelId: "glm-vision", acceptsImages: true },
      { providerId: "zai", modelId: "glm-text", acceptsImages: false },
    ]);
    on();
  });

  it("is off for every model until the user switches it on", () => {
    expect(computerLane({ provider: "anthropic", name: "claude-haiku-4-5" })).toBeNull();
    on("anthropic/claude-haiku-4-5");
    expect(computerLane({ provider: "anthropic", name: "claude-haiku-4-5" })).toBe("native-anthropic");
    expect(computerLane({ provider: "anthropic", name: "claude-sonnet-4-6" })).toBeNull();
  });

  it("gives the provider's own tool only where the catalog flags the model AND the API speaks that format", () => {
    on("openai/gpt-6-sol", "openai/gpt-4o", "google/gemini-2.5-computer-use-preview-10-2025");
    expect(computerLane({ provider: "openai", name: "gpt-6-sol" })).toBe("native-openai");
    expect(computerLane({ provider: "openai", name: "gpt-4o" })).toBe("own");
    // Gemini's own tool drives a browser only.
    expect(computerLane({ provider: "google", name: "gemini-2.5-computer-use-preview-10-2025" })).toBe("own");
  });

  it("treats Claude behind Bedrock's Anthropic format as native Anthropic", () => {
    const m = { provider: "custom::bedrock", name: "us.anthropic.claude-haiku-4-5-20251001-v1:0" };
    on("custom::bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(computerLane(m)).toBe("native-anthropic");
  });

  it("gives our own tool once a provider has refused its own, and remembers that across processes", () => {
    const m = { provider: "anthropic", name: "claude-haiku-4-5" };
    on("anthropic/claude-haiku-4-5");
    rememberNativeRejected(m);
    expect(computerLane(m)).toBe("own");
    __resetComputerLaneForTests(); // a new process reads it back from disk
    expect(computerLane(m)).toBe("own");
  });

  it("checks the MODEL behind an Anthropic-format endpoint, not just the format (A1)", () => {
    // Z.ai, MiniMax and Kimi serve text-only models in Anthropic's format.
    const glm = { provider: "custom::zai", name: "zai.glm-4.7-flash" };
    on("custom::zai/zai.glm-4.7-flash");
    expect(computerUseIneligible(glm)).toBe("no-vision");
    expect(computerLane(glm)).toBeNull();
  });

  it("says why a model can't have it, instead of hiding it", () => {
    on("zai/glm-text", "zai/glm-vision");
    expect(computerUseIneligible({ provider: "zai", name: "glm-text" })).toBe("no-vision");
    // Sees images, but its API's tool messages are text-only.
    expect(computerUseIneligible({ provider: "zai", name: "glm-vision" })).toBe("no-tool-images");
    expect(computerLane({ provider: "zai", name: "glm-vision" })).toBeNull();
    expect(computerUseIneligible({ provider: "anthropic", name: "claude-haiku-4-5" })).toBeNull();
  });
});

describe("isNativeComputerToolRejection", () => {
  const ANTHROPIC_55 = ANTHROPIC_400;

  it("recognises the refusal, at the top level and wrapped in the SDK's onError event", () => {
    expect(isNativeComputerToolRejection(ANTHROPIC_55)).toBe(true);
    expect(isNativeComputerToolRejection({ error: ANTHROPIC_55 })).toBe(true);
  });

  it("ignores other failures", () => {
    expect(isNativeComputerToolRejection(Object.assign(new Error("computer tool exploded"), { statusCode: 500 }))).toBe(false);
    expect(isNativeComputerToolRejection(Object.assign(new Error("invalid x-api-key"), { statusCode: 401 }))).toBe(false);
    expect(
      isNativeComputerToolRejection(Object.assign(new Error("tool_choice is not supported"), { statusCode: 400 })),
    ).toBe(false);
  });
});

describe("a refused native tool never costs the turn", () => {
  it("retries the same round at once with our tool and finishes", async () => {
    const { runStreamRoundWithEmptyOutputRetry } = await import(
      "@/ipc/handlers/chat_stream/turn-runner/round-retry"
    );
    const { createStreamTurnContext } = await import("@/ipc/handlers/chat_stream/turn-context");
    const ctx = createStreamTurnContext();
    ctx.nativeComputerSent = { provider: "anthropic", name: "claude-haiku-5-5" };
    __resetComputerLaneForTests();

    // A request-phase 400 reaches round-retry only as the SDK's substitute.
    const substitute = Object.assign(new Error("No output generated."), { name: "AI_NoOutputGeneratedError" });
    const refused = {
      // eslint-disable-next-line require-yield
      fullStream: (async function* () {
        throw substitute;
      })(),
      finishReason: Promise.reject(substitute),
      getRecordedNativeComputerRejection: () => ({ error: ANTHROPIC_400 }),
    };
    refused.finishReason.catch(() => {});
    const answered = {
      fullStream: (async function* () {
        yield { type: "text-delta", id: "t", text: "done" };
      })(),
      finishReason: Promise.resolve("stop"),
    };
    const runSimpleStream = vi
      .fn()
      .mockResolvedValueOnce(refused)
      .mockImplementationOnce(async () => {
        // The second round is built after the flag flips: simple-stream-text
        // then keeps our own tool.
        expect(ctx.nativeComputerRejected).toBe(true);
        return answered;
      });

    const result = await runStreamRoundWithEmptyOutputRetry(
      ctx,
      { event: { sender: { send() {}, isDestroyed: () => false } } as never },
      {
        runSimpleStream,
        fullResponse: "",
        abortController: new AbortController(),
        chatId: 1,
        processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
      },
    );
    expect(runSimpleStream).toHaveBeenCalledTimes(2);
    expect(result.finishReason).toBe("stop");
    expect(computerLane({ provider: "anthropic", name: "claude-haiku-5-5" })).not.toBe("native-anthropic");
  });
});


describe("toolset", () => {
  it("offers computer only to a model it is switched on for, in Build, attended", async () => {
    await import("@/lib/tools/index");
    const { resolveToolsetForSession } = await import("@/lib/tools/resolve-toolset");
    __setCatalogIdsForTests([]);
    const names = (branch: "ask" | "build", unattended = false) =>
      resolveToolsetForSession({
        branch,
        effectiveWorkMode: branch,
        hasWorkspace: true,
        workspaceIntegrationEligible: true,
        model: { name: "gpt-4o", provider: "openai", builtinProviderId: "openai" },
        unattended,
      }).tools.map((t) => t.name);

    on();
    expect(names("build")).not.toContain("computer");
    on("openai/gpt-4o");
    expect(names("build")).toContain("computer");
    expect(names("ask")).not.toContain("computer");
    expect(names("build", true)).not.toContain("computer");
  });
});

describe.skipIf(process.platform === "win32")("the tool against an executor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-helper-"));
  const log = path.join(dir, "ops.log");
  const fake = path.join(dir, "fake-helper.cjs");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const r = JSON.parse(l);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(r) + "\\n");
  let out = { id: r.id, ok: true };
  if (r.op === "screenshot") Object.assign(out, { width: 4, height: 3, mime: "image/jpeg", data: "AAAA" });
  if (r.op === "permissions") Object.assign(out, { screen: "denied", accessibility: "granted", app: "Terminal" });
  if (r.op === "click" && process.env.FAKE_TAKEOVER === "1")
    out = { id: r.id, ok: false, code: "user_took_control", error: "moved" };
  process.stdout.write(JSON.stringify(out) + "\\n");
});
`,
    { mode: 0o755 },
  );
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function tool() {
    const { stopHelper } = await import("@/lib/computer/helper");
    stopHelper();
    fs.rmSync(log, { force: true });
    process.env.ATLARIX_COMPUTER_HELPER = fake;
    await import("@/lib/tools/computer");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    return ToolRegistry.get("computer")!.handler;
  }
  const ops = () =>
    fs
      .readFileSync(log, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).op);

  it("acts, then returns a screenshot marked as untrusted screen content", async () => {
    delete process.env.FAKE_TAKEOVER;
    const run = await tool();
    const out = await run({ action: "left_click", coordinate: [1, 2], _turnId: "turn-a" });
    expect(out).toMatchObject({ success: true, mimeType: "image/jpeg", data: "AAAA", untrustedSource: "screen" });
    // Once per turn, the takeover check starts fresh.
    await run({ action: "screenshot", _turnId: "turn-a" });
    expect(ops()).toEqual(["reset", "click", "screenshot", "screenshot"]);
  });

  it("runs OpenAI's batch through the same executor", async () => {
    const run = await tool();
    await run({ actions: [{ type: "type", text: "hi" }, { type: "keypress", keys: ["ENTER"] }], _turnId: "turn-b" });
    expect(ops()).toEqual(["reset", "type", "key", "screenshot"]);
  });

  it("cuts a wait short when the turn is stopped", async () => {
    delete process.env.FAKE_TAKEOVER;
    const run = await tool();
    const { markChatUserStopped, clearChatUserStopped } = await import("@/ipc/handlers/chat_stream/stream-state");
    const t0 = Date.now();
    setTimeout(() => markChatUserStopped(4242), 300);
    await run({ action: "wait", duration: 10, _turnId: "turn-w", _chatSessionId: 4242 });
    clearChatUserStopped(4242);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it.skipIf(process.platform !== "darwin")("says which app macOS will name before it asks", async () => {
    await tool();
    const { computerUseGrantNotice } = await import("@/lib/computer/lane");
    expect(await computerUseGrantNotice()).toBe(
      "macOS will ask to let Terminal record the screen and control the computer. That's Atlarix's computer use.",
    );
  });

  it("stops the turn when the user takes the mouse", async () => {
    process.env.FAKE_TAKEOVER = "1";
    const run = await tool();
    const stop = vi.fn();
    const out = await run({ action: "left_click", coordinate: [1, 2], _turnId: "turn-c", _stopTurn: stop });
    // The reason is handed back first; the stop follows it (E3: no reason shown).
    expect(out).toMatchObject({ success: false, error: "Stopped: the mouse moved, so Atlarix gave you back control." });
    expect(stop).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 120));
    expect(stop).toHaveBeenCalledOnce();
    delete process.env.FAKE_TAKEOVER;
  });
});

describe("the CLI and ACP title of a computer action", () => {
  it("names what it did on the screen, for both lanes' shapes", async () => {
    const { toolTarget } = await import("@/cli/agent/transcript");
    expect(toolTarget("computer", { action: "left_click", coordinate: [640, 400] })).toBe("left click 640,400");
    expect(toolTarget("computer", { action: "type", text: "hello" })).toBe('type "hello"');
    expect(toolTarget("computer", { actions: [{ type: "click" }, { type: "keypress" }] })).toBe("click, keypress");
  });
});

describe("what the model is told a screenshot is", () => {
  it("calls a desktop screenshot the screen, not a browser page", async () => {
    const { buildToolModelOutput } = await import("@/lib/ai/tool-model-output");
    const out = buildToolModelOutput(
      "computer",
      { success: true, mimeType: "image/jpeg", data: "AAAA", width: 4, height: 3, untrustedSource: "screen" },
      { builtinProviderId: "anthropic", modelApiId: "claude-haiku-4-5" },
    ) as { type: string; value: Array<{ type: string; text?: string }> };
    const caption = out.value.find((p) => p.type === "text")?.text ?? "";
    expect(caption).toMatch(/^Image of the screen\./);
    expect(caption).not.toMatch(/browser/);
  });
});
