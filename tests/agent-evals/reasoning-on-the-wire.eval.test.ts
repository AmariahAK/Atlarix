import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import {
  registerModelsDevReasoning,
  __resetReasoningRegistryForTests,
} from "@/lib/routing/model-reasoning-profile";

/**
 * Does the Deep-thinking toggle reach the REQUEST?
 *
 * It did not — for Atlarix Core or for any OpenAI-compatible BYOK provider
 * (deepseek / qwen / minimax / a custom endpoint). `resolveReasoningRequest` has
 * always resolved the right per-model control, but its output was only ever read as
 * a boolean "can this model reason"; nothing ever placed it in a body. Every unit
 * test in this area asserted the resolver and passed while the wire stayed empty,
 * which is exactly why this one asserts the bytes the provider receives instead.
 *
 * The second thing it pins is the KEY. `reasoningEffort` is the SDK's provider
 * option and it maps to the body's `reasoning_effort`; supplying the snake_case
 * spelling ourselves looks equivalent and silently sends nothing, because
 * @ai-sdk/openai-compatible spreads the bucket and then writes `reasoning_effort:
 * compatibleOptions.reasoningEffort ?? undefined` over the top of it.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/app.ts": "export const app = 1;\n" },
  });
  // The seeded provider is OpenAI-compatible, the same shape Core and the
  // open-weight BYOK providers use, so what it receives is what they receive.
  registerModelsDevReasoning([
    {
      providerId: ctx.providerId,
      modelId: ctx.modelName,
      profile: {
        reasoning: true,
        options: [{ type: "effort", values: ["high", "max"] }],
      },
      supportsTemperature: true,
    },
  ]);
});

afterAll(async () => {
  __resetReasoningRegistryForTests();
  await ctx.cleanup();
});

function bodiesFor(scenarioId: string): Array<Record<string, unknown>> {
  return ctx.server.requestsFor(scenarioId) as Array<Record<string, unknown>>;
}

describe("reasoning reaches the provider", () => {
  it("Deep ON sends the model's declared maximum", async () => {
    ctx.server.register(scenario("reasoning-deep-on").text("ok done.").build());
    const chatId = await ctx.newChat();
    await runTurn(ctx, {
      chatId,
      prompt: "sc=reasoning-deep-on hello",
      mode: "ask",
      settings: { deepThinking: true },
    });
    const body = bodiesFor("reasoning-deep-on")[0];
    expect(body).toBeDefined();
    expect(body.reasoning_effort).toBe("max");
  }, 30_000);

  it("Deep OFF sends one step below it — never a level the model did not list", async () => {
    ctx.server.register(
      scenario("reasoning-deep-off").text("ok done.").build(),
    );
    const chatId = await ctx.newChat();
    await runTurn(ctx, {
      chatId,
      prompt: "sc=reasoning-deep-off hello",
      mode: "ask",
      settings: { deepThinking: false },
    });
    const body = bodiesFor("reasoning-deep-off")[0];
    expect(body).toBeDefined();
    // The model declares ["high","max"], so OFF is "high" — NOT the "medium" a
    // global effort ladder would have sent.
    expect(body.reasoning_effort).toBe("high");
  }, 30_000);
});
