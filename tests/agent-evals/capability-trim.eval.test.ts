import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v12 2.1 (+1.6) — per-model capability trim, the LAST stage of the
 * tool-resolution pipeline. A clearly-weak model (small param count in the
 * id, unknown family) gets a core-first, cost-ranked trimmed toolset and
 * simplified schemas; strong models keep the full surface (the existing
 * surface evals are the full-surface regression guard).
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
  tools?: Array<{ function?: { name?: string; parameters?: unknown } }>;
};

const offeredToolNames = (req: RecordedRequest): string[] =>
  (req.tools ?? [])
    .map((t) => t.function?.name)
    .filter((n): n is string => typeof n === "string");

describe("capability trim (2.1 / 1.6)", () => {
  it("weak model: ask toolset is capped with core tools present", async () => {
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
    expect(tools.length, `offered: ${tools.join(",")}`).toBeLessThanOrEqual(12);
    // Core read surface survives the trim.
    expect(tools).toContain("read_file");
    expect(tools).toContain("search");
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
