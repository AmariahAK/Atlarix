import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, getIpcHandler, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { writeTestSettings } from "../infra/settings";
import { makeFakeIpcEvent } from "../infra/ipc";
import {
  registerModelsDevReasoning,
  __resetReasoningRegistryForTests,
} from "@/lib/routing/model-reasoning-profile";

/**
 * Each app chat runs on ITS model, effort and mode (15.11.1).
 *
 * QA (ai-44, joint run): picking a model or a mode in one chat changed the next
 * turn of every other chat, because the app kept one copy of each, in global
 * settings. Here two sessions store different choices and the app's settings
 * name a third; each turn, sent the way the app sends one for a chat that is
 * not on screen (no model, effort or mode in the request), must reach the
 * provider with its own chat's.
 */

let ctx: EvalContext;
const MODEL_B = "agent-eval-model-b";

async function call(channel: string, ...args: unknown[]) {
  const handler = await getIpcHandler(channel);
  return (handler as unknown as (e: unknown, ...a: unknown[]) => Promise<unknown>)({}, ...args);
}

type Body = { model?: string; reasoning_effort?: string; tools?: Array<{ function?: { name?: string } }> };
const toolNames = (b: Body) => (b.tools ?? []).map((t) => t.function?.name ?? "");
const WRITES = /^(edit_file|write_file|apply_patch|delete_file)$/;

async function turnIn(chatId: number, sessionId: string, sc: string) {
  ctx.server.register(scenario(sc).text("ok done.").build());
  const fakeIpc = makeFakeIpcEvent();
  const handler = await getIpcHandler("chat:stream");
  await handler(fakeIpc.event, { chatId, prompt: `sc=${sc} hello`, workspaceSessionId: sessionId });
  await fakeIpc.waitFor("chat:response:end", (p) => p?.chatId === chatId, 40_000);
  const body = ctx.server.requestsFor(sc)[0] as Body;
  expect(body).toBeDefined();
  return body;
}

beforeAll(async () => {
  ctx = await setupEvalContext({ seedFiles: { "src/x.ts": "export const x = 1;\n" } });
  const { db } = await import("@/db");
  const schema = await import("@/db/schema");
  await db.insert(schema.language_models).values({
    displayName: MODEL_B,
    apiName: MODEL_B,
    customProviderId: ctx.providerId,
  });
  registerModelsDevReasoning([
    {
      providerId: ctx.providerId,
      modelId: ctx.modelName,
      profile: { reasoning: true, options: [{ type: "effort", values: ["low", "medium", "high"] }] },
      supportsTemperature: true,
    },
    {
      providerId: ctx.providerId,
      modelId: MODEL_B,
      profile: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] },
      supportsTemperature: true,
    },
  ]);
});

afterAll(async () => {
  __resetReasoningRegistryForTests();
  await ctx.cleanup();
});

describe("per-chat model, effort and mode", () => {
  it("two chats each run on their own; the app's pick is only the default", async () => {
    writeTestSettings({
      selectedModel: { name: ctx.modelName, provider: ctx.providerId },
      selectedChatMode: "build",
      intentMode: "build",
      workModePreference: "build",
      effort: "",
      deepThinking: false,
      hasRunBefore: true,
      telemetryConsent: "opted_out",
    });
    const a = (await call("sessions:create", ctx.appId)) as { id: string; model: unknown; workMode: string };
    const b = (await call("sessions:create", ctx.appId)) as { id: string };
    // A new chat starts with the last pick.
    expect(a.model).toEqual({ provider: ctx.providerId, name: ctx.modelName, deepThinking: false });
    expect(a.workMode).toBe("build");

    // Chat A: model A at "low", Explore. Chat B: model B at "max", Build.
    await call("sessions:set-model", a.id, { provider: ctx.providerId, name: ctx.modelName, effort: "low", deepThinking: false });
    await call("sessions:set-work-mode", a.id, "ask");
    await call("sessions:set-model", b.id, { provider: ctx.providerId, name: MODEL_B, effort: "max", deepThinking: true });
    await call("sessions:set-work-mode", b.id, "build");

    // The app-wide pick moves on (as it does when the user picks in a third chat).
    writeTestSettings({
      selectedModel: { name: MODEL_B, provider: ctx.providerId },
      effort: "high",
      workModePreference: "plan",
    });

    const chatA = await ctx.newChat();
    const chatB = await ctx.newChat();
    const bodyA = await turnIn(chatA, a.id, "perchat-a1");
    const bodyB = await turnIn(chatB, b.id, "perchat-b1");

    expect(bodyA.model).toBe(ctx.modelName);
    expect(bodyA.reasoning_effort).toBe("low");
    expect(toolNames(bodyA).some((n) => WRITES.test(n))).toBe(false);

    expect(bodyB.model).toBe(MODEL_B);
    expect(bodyB.reasoning_effort).toBe("max");
    expect(toolNames(bodyB).some((n) => WRITES.test(n))).toBe(true);

    // Interleaved: A again after B ran, still A's.
    const bodyA2 = await turnIn(chatA, a.id, "perchat-a2");
    expect(bodyA2.model).toBe(ctx.modelName);
    expect(bodyA2.reasoning_effort).toBe("low");
  }, 120_000);

  it("a model picked without an effort keeps the chat's level only when the new model lists it", async () => {
    const s = (await call("sessions:create", ctx.appId)) as { id: string };
    await call("sessions:set-model", s.id, { provider: ctx.providerId, name: ctx.modelName, effort: "low", deepThinking: false });
    // B lists "low" too (and not as its default): kept.
    const kept = (await call("sessions:set-model", s.id, { provider: ctx.providerId, name: MODEL_B })) as {
      model: { effort?: string };
    };
    expect(kept.model.effort).toBe("low");
    await call("sessions:set-model", s.id, { provider: ctx.providerId, name: MODEL_B, effort: "max", deepThinking: true });
    // A does not list "max": its own default.
    const reset = (await call("sessions:set-model", s.id, { provider: ctx.providerId, name: ctx.modelName })) as {
      model: { effort?: string; deepThinking?: boolean };
    };
    expect(reset.model.effort).toBeUndefined();
    expect(reset.model.deepThinking).toBe(false);
  });

  it("refuses a model choice that is not one", async () => {
    const s = (await call("sessions:create", ctx.appId)) as { id: string };
    for (const junk of [null, {}, { provider: "", name: "x" }, { provider: "p" }, "model"]) {
      await expect(call("sessions:set-model", s.id, junk)).rejects.toThrow(/Invalid model choice/);
    }
    await expect(
      call("sessions:set-model", "no-such-session", { provider: ctx.providerId, name: ctx.modelName }),
    ).rejects.toThrow(/not found/i);
  });
});
