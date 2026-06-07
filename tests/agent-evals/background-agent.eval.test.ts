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

describe("background agents V2 — write + approval gate (2.3)", () => {
  it("a write-mode agent auto-approves its write (no human) and records the diff", async () => {
    ctx.server.register(
      scenario("bg-write")
        .toolCall("write_file", {
          path: "src/generated.ts",
          content: "export const gen = 1;\n",
          description: "generate a module",
        })
        .text("Created src/generated.ts. <task_complete>")
        .build(),
    );
    const {
      startBackgroundAgent,
      listBackgroundAgents,
      _resetBackgroundAgents,
    } = await import("@/lib/agents/background-agent");
    _resetBackgroundAgents();

    // NO `during` callback — the runner's auto-approver must drive the write.
    const { sessionId } = await startBackgroundAgent({
      appId: ctx.appId,
      prompt: "sc=bg-write Generate a module.",
      mode: "build",
      title: "gen module",
      startedAt: 3_000,
    });

    const rec = listBackgroundAgents().find((a) => a.sessionId === sessionId)!;
    expect(rec.status).toBe("done");
    expect(ctx.ws.exists("src/generated.ts")).toBe(true);
    expect(rec.changedFiles).toContain("src/generated.ts");
  }, 30_000);

  it("resolve('revert') deletes the created file; ('keep') leaves it", async () => {
    const {
      startBackgroundAgent,
      resolveBackgroundAgent,
      _resetBackgroundAgents,
    } = await import("@/lib/agents/background-agent");

    // keep
    ctx.server.register(
      scenario("bg-keep")
        .toolCall("write_file", {
          path: "src/keep-me.ts",
          content: "export const k = 1;\n",
          description: "keep",
        })
        .text("done <task_complete>")
        .build(),
    );
    _resetBackgroundAgents();
    const keep = await startBackgroundAgent({
      appId: ctx.appId,
      prompt: "sc=bg-keep w",
      mode: "build",
      startedAt: 4_000,
    });
    expect(ctx.ws.exists("src/keep-me.ts")).toBe(true);
    const keepRes = await resolveBackgroundAgent(keep.sessionId, "keep");
    expect(keepRes.reverted).toBe(false);
    expect(ctx.ws.exists("src/keep-me.ts")).toBe(true);

    // revert
    ctx.server.register(
      scenario("bg-revert")
        .toolCall("write_file", {
          path: "src/revert-me.ts",
          content: "export const r = 1;\n",
          description: "revert",
        })
        .text("done <task_complete>")
        .build(),
    );
    _resetBackgroundAgents();
    const rev = await startBackgroundAgent({
      appId: ctx.appId,
      prompt: "sc=bg-revert w",
      mode: "build",
      startedAt: 5_000,
    });
    expect(ctx.ws.exists("src/revert-me.ts")).toBe(true);
    const revRes = await resolveBackgroundAgent(rev.sessionId, "revert");
    expect(revRes.reverted).toBe(true);
    // created file is deleted on revert
    expect(ctx.ws.exists("src/revert-me.ts")).toBe(false);
  }, 40_000);

  it("status persists across a simulated reload (hydrate from DB)", async () => {
    ctx.server.register(
      scenario("bg-persist").text("ok <task_complete>").build(),
    );
    const {
      startBackgroundAgent,
      hydrateBackgroundAgentsFromDb,
      listBackgroundAgents,
      _resetBackgroundAgents,
    } = await import("@/lib/agents/background-agent");
    _resetBackgroundAgents();
    const { sessionId } = await startBackgroundAgent({
      appId: ctx.appId,
      prompt: "sc=bg-persist analyze",
      startedAt: 6_000,
    });
    expect(
      listBackgroundAgents().find((a) => a.sessionId === sessionId)?.status,
    ).toBe("done");

    // Simulate restart: wipe the in-memory map, rehydrate from the DB rows.
    _resetBackgroundAgents();
    expect(listBackgroundAgents()).toHaveLength(0);
    await hydrateBackgroundAgentsFromDb();
    const hydrated = listBackgroundAgents().find(
      (a) => a.sessionId === sessionId,
    );
    expect(hydrated?.status).toBe("done"); // survived the reload
  }, 30_000);

  it("keep/revert still works after a simulated reload (agent_meta, S16)", async () => {
    ctx.server.register(
      scenario("bg-restart-revert")
        .toolCall("write_file", {
          path: "src/restart-revert-me.ts",
          content: "export const rr = 1;\n",
          description: "write then revert after reload",
        })
        .text("done <task_complete>")
        .build(),
    );
    const {
      startBackgroundAgent,
      resolveBackgroundAgent,
      hydrateBackgroundAgentsFromDb,
      listBackgroundAgents,
      _resetBackgroundAgents,
    } = await import("@/lib/agents/background-agent");
    _resetBackgroundAgents();
    const { sessionId } = await startBackgroundAgent({
      appId: ctx.appId,
      prompt: "sc=bg-restart-revert w",
      mode: "build",
      startedAt: 7_000,
    });
    expect(ctx.ws.exists("src/restart-revert-me.ts")).toBe(true);

    // Simulate restart BEFORE the user resolves the approval gate.
    _resetBackgroundAgents();
    await hydrateBackgroundAgentsFromDb();
    const hydrated = listBackgroundAgents().find(
      (a) => a.sessionId === sessionId,
    );
    // The gate fields came back from the persisted agent_meta JSON.
    expect(hydrated?.mode).toBe("build");
    expect(hydrated?.snapshotTurnId).toBeTruthy();
    expect(hydrated?.changedFiles).toContain("src/restart-revert-me.ts");

    // Revert still works — pre-S16 this failed with "No snapshot to revert".
    const res = await resolveBackgroundAgent(sessionId, "revert");
    expect(res.reverted).toBe(true);
    expect(ctx.ws.exists("src/restart-revert-me.ts")).toBe(false);
  }, 40_000);
});
