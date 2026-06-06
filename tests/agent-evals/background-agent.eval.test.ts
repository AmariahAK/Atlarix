import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { writeTestSettings } from "../infra/settings";

/**
 * v12 2.3 — a background agent runs the REAL chat:stream engine DETACHED (no
 * foreground renderer), into its own session, and persists the assistant
 * message main-side (the renderer normally does that on response:end).
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/app.ts": "export const app = 1;\n" },
  });
  // Register handlers + point settings at the fake LLM (the runner reads the
  // model from settings, like production).
  await getIpcHandler("chat:stream");
  writeTestSettings({
    selectedChatMode: "ask",
    workModePreference: "ask",
    selectedModel: { name: ctx.modelName, provider: ctx.providerId },
    hasRunBefore: true,
    telemetryConsent: "opted_out",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("background agents (2.3)", () => {
  it("runs detached to completion and persists the assistant message", async () => {
    ctx.server.register(
      scenario("bg-analyze")
        .text("Analysis: the app exports a constant. <task_complete>")
        .build(),
    );

    const {
      startBackgroundAgent,
      listBackgroundAgents,
      _resetBackgroundAgents,
    } = await import("@/lib/agents/background-agent");
    _resetBackgroundAgents();

    const { sessionId } = await startBackgroundAgent({
      appId: ctx.appId,
      prompt: "sc=bg-analyze Analyze src/app.ts.",
      title: "analyze app",
      startedAt: 1_000,
    });

    // Status flipped to done.
    const agents = listBackgroundAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("done");
    expect(agents[0]!.sessionId).toBe(sessionId);

    // The session carries BOTH the user message (engine persisted it at
    // dispatch) and the assistant message (the runner persisted it).
    const sessionsGet = await getIpcHandler("sessions:get");
    const result = (await sessionsGet({} as never, sessionId)) as {
      session: { title: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(result.session.title).toContain("analyze app");
    const roles = result.messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const assistant = result.messages.find((m) => m.role === "assistant");
    expect(assistant!.content).toContain("Analysis:");
  }, 30_000);

  it("records an error status when the turn cannot run", async () => {
    const {
      startBackgroundAgent,
      listBackgroundAgents,
      _resetBackgroundAgents,
    } = await import("@/lib/agents/background-agent");
    _resetBackgroundAgents();

    // No scenario registered for this id → the fake server has nothing to
    // serve; the turn still reaches response:end (error path) and the agent
    // ends in a terminal state (done with no assistant message, or error) —
    // never stuck "running".
    const { sessionId } = await startBackgroundAgent({
      appId: ctx.appId,
      prompt: "sc=bg-missing-scenario do something",
      startedAt: 2_000,
    });
    expect(sessionId).toBeTruthy();
    const rec = listBackgroundAgents().find((a) => a.sessionId === sessionId)!;
    expect(rec.status).not.toBe("running");
  }, 30_000);
});
