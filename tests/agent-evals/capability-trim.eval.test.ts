import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * Per-model capability handling for the tool-resolution pipeline. The v13
 * capability-TRIM stage (a core-first, cost-ranked tool-COUNT cap for weak
 * models) was removed — at ~22 tools the cap was unnecessary, so every model
 * now gets the full mode allowlist. What remains for a clearly-weak model
 * (small param count in the id, unknown family) is parameter-schema
 * simplification only; the tool COUNT matches strong models.
 */

let ctx: EvalContext;
let weakModelName: string;
let weakProviderId: string;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/cap.ts": "export const cap = 1;\n" },
  });
  // Second provider on the same fake server with a weak-looking model id.
  const seeded = await ctx.testDb.seedTestingProvider(ctx.server.baseURL, {
    providerId: "agent-eval-weak",
    modelName: "tiny-llm-7b-instruct",
  });
  weakModelName = seeded.modelName;
  weakProviderId = seeded.providerId;
});

afterAll(async () => {
  await ctx.cleanup();
});

type RecordedRequest = {
  tools?: Array<{
    function?: { name?: string; description?: string; parameters?: unknown };
  }>;
};

const descOf = (req: RecordedRequest, name: string): string | undefined =>
  (req.tools ?? []).find((t) => t.function?.name === name)?.function
    ?.description;

const offeredToolNames = (req: RecordedRequest): string[] =>
  (req.tools ?? [])
    .map((t) => t.function?.name)
    .filter((n): n is string => typeof n === "string");

describe("capability trim (2.1 / 1.6)", () => {
  it("weak model: ask toolset is NOT count-capped (trim removed in v13), core tools present", async () => {
    ctx.server.register(scenario("cap-weak-ask").text("Nimeelewa.").build());

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cap-weak-ask What is in src/cap.ts?",
      mode: "ask",
      settings: {
        selectedModel: { name: weakModelName, provider: weakProviderId },
      },
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor(
      "cap-weak-ask",
    ) as RecordedRequest[];
    const tools = offeredToolNames(requests[0]);
    // The trim stage was removed in v13 — a weak model now gets the full ask
    // surface (no tool-COUNT cap), differing from strong models only by
    // simplified parameter schemas (asserted separately below).
    expect(tools.length, `offered: ${tools.join(",")}`).toBeGreaterThan(12);
    // Core read surface is present.
    expect(tools).toContain("read_file");
    expect(tools).toContain("grep");
  }, 30_000);

  it("strong model (default): full ask surface, untouched by the trim", async () => {
    ctx.server.register(
      scenario("cap-strong-ask").text("Sawa kabisa.").build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cap-strong-ask What is in src/cap.ts?",
      mode: "ask",
    });
    expectNoStreamError(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor(
      "cap-strong-ask",
    ) as RecordedRequest[];
    const tools = offeredToolNames(requests[0]);
    // The harness model ("agent-eval-model") is an unknown family with no
    // small-param hint → DEFAULT full surface (well above the weak cap).
    expect(tools.length).toBeGreaterThan(12);
    expect(tools).toContain("read_file");
    expect(tools).toContain("ask_user");
  }, 30_000);

  it("weak model: offered schemas are simplified (optional params capped)", async () => {
    ctx.server.register(scenario("cap-weak-schema").text("Vizuri.").build());

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=cap-weak-schema Hello.",
      mode: "ask",
      settings: {
        selectedModel: { name: weakModelName, provider: weakProviderId },
      },
    });
    expectNoStreamError(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor(
      "cap-weak-schema",
    ) as RecordedRequest[];
    const readFile = (requests[0].tools ?? []).find(
      (t) => t.function?.name === "read_file",
    );
    expect(readFile).toBeTruthy();
    const params = readFile!.function!.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const required = new Set(params.required ?? []);
    const optionalCount = Object.keys(params.properties ?? {}).filter(
      (k) => !required.has(k),
    ).length;
    expect(optionalCount).toBeLessThanOrEqual(3);
  }, 30_000);
});

describe("v14.8.8 — per-tool guidance rides the capability-gated tool schema", () => {
  it("build mode: run_command's description carries the relocated background/preview guidance", async () => {
    ctx.server.register(scenario("guidance-build").text("Done.").build());
    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=guidance-build Build it.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);

    const req = (
      ctx.server.requestsFor("guidance-build") as RecordedRequest[]
    )[0];
    const runCmd = descOf(req, "run_command");
    expect(runCmd).toBeTruthy();
    // The guidance relocated out of AGENTS.md now lives on the tool itself.
    expect(runCmd).toMatch(/auto-background|background=true/i);
    // v14.15.0 removed the Preview tab — a dev server's localhost URL is now
    // opened as a BROWSER tab, so the guidance points at the browser rather
    // than the old target:"preview". This assertion tracked the deleted feature.
    //
    // v14.41: browser 6→2, so it names the consolidated tool. Asserting on the
    // retired `browser_navigate` would now pass through the alias map while the
    // model was being shown a name it cannot call — which is the exact failure
    // this eval exists to catch, one level up.
    expect(runCmd).toContain("browser(");
    // Browser guidance is present because browser tools are in build mode.
    expect(descOf(req, "browser")).toBeTruthy();
    // v14.8.9 removed a "VISUAL confirmation" lure (the observed bug); 15.11
    // replaced "LAST RESORT" with when a screenshot helps. Bound in full.
    const inspect = descOf(req, "browser_inspect")!;
    expect(inspect).toContain("cheap way to see a page");
    expect(inspect).not.toContain("VISUAL confirmation");
  }, 30_000);

  it("ask mode: edit_file (and its mutation guidance) is absent — capability-gated for free", async () => {
    ctx.server.register(scenario("guidance-ask").text("Answer.").build());
    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=guidance-ask What is here?",
      mode: "ask",
    });
    expectNoStreamError(fakeIpc.sends, chatId);

    const req = (
      ctx.server.requestsFor("guidance-ask") as RecordedRequest[]
    )[0];
    // edit_file isn't in read-only ask mode → the model never sees its write/
    // replace guidance, with no conditional prose needed (it rides the gated
    // schema). This is the mechanism the AGENTS.md relocation relies on.
    expect(offeredToolNames(req)).not.toContain("edit_file");
    expect(descOf(req, "edit_file")).toBeUndefined();
  }, 30_000);
});
