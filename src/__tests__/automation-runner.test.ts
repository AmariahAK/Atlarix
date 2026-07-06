import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Runner semantics: arm/disarm, queue concurrency 1 with per-automation
 * dedupe, and boot recovery of runs interrupted by an app quit. node-cron and
 * the DB layer are mocked; executeRun is injected.
 */

const { cronTasks } = vi.hoisted(() => ({
  cronTasks: [] as Array<{ expr: string; fn: () => void; stopped: boolean }>,
}));
vi.mock("node-cron", () => ({
  validate: (expr: string) => expr.split(" ").length === 5,
  schedule: (expr: string, fn: () => void) => {
    const task = { expr, fn, stopped: false, stop: () => {} };
    task.stop = () => {
      task.stopped = true;
    };
    cronTasks.push(task);
    return task;
  },
}));

const { state } = vi.hoisted(() => ({
  state: {
    automations: new Map<string, Record<string, unknown>>(),
    staleRuns: [] as Array<{ id: string; sessionId: string | null; status: string }>,
    runUpdates: [] as Array<Record<string, unknown>>,
    sessionUpdates: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("@/db", () => {
  const makeWhere = (table: string) => ({
    where: (_cond: unknown) => {
      if (table === "automations") return [...state.automations.values()];
      if (table === "automationRuns") return state.staleRuns;
      return [];
    },
  });
  return {
    db: {
      query: {
        automations: {
          findFirst: async () => null, // per-test override via automationsFindFirst
        },
        automationRuns: {
          findFirst: async () => null,
        },
      },
      select: () => ({
        from: (table: { _name?: string } | unknown) => {
          // drizzle table objects — identify by known columns
          const t = table as Record<string, unknown>;
          if ("trigger" in t) return makeWhere("automations");
          if ("automationId" in t) return makeWhere("automationRuns");
          return makeWhere("other");
        },
      }),
      update: (table: Record<string, unknown>) => ({
        set: (values: Record<string, unknown>) => ({
          where: (_cond: unknown) => {
            if ("automationId" in table) state.runUpdates.push(values);
            else if ("agentMeta" in table) state.sessionUpdates.push(values);
            return Promise.resolve();
          },
        }),
      }),
      insert: () => ({ values: async () => {} }),
    },
  };
});

vi.mock("@/db/schema", () => ({
  automations: { trigger: "col", enabled: "col" },
  automationRuns: { automationId: "col", status: "col", error: "col" },
  chatSessions: { agentMeta: "col", status: "col" },
}));

import {
  enqueueRun,
  resetAutomationRunnerForTests,
  startAutomationRunner,
  type RunnerDeps,
} from "@/lib/automations/runner";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeDeps(overrides?: Partial<RunnerDeps>): RunnerDeps & {
  executed: Array<{ id: string; context: string | null }>;
} {
  const executed: Array<{ id: string; context: string | null }> = [];
  return {
    executed,
    executeRun: vi.fn(async (id: string, context: string | null) => {
      executed.push({ id, context });
      await sleep(30);
      return { runId: `run-${id}` };
    }),
    pollGithub: vi.fn(async () => ({ fired: false, nextCursor: {} })),
    pollMcp: vi.fn(async () => ({ fired: false, nextCursor: { hash: "h" } })),
    ...overrides,
  };
}

describe("automation runner", () => {
  beforeEach(() => {
    state.automations.clear();
    state.staleRuns.length = 0;
    state.runUpdates.length = 0;
    state.sessionUpdates.length = 0;
    cronTasks.length = 0;
  });
  afterEach(() => {
    resetAutomationRunnerForTests();
    vi.restoreAllMocks();
  });

  it("runs queued automations one at a time and dedupes per automation", async () => {
    const deps = makeDeps();
    startAutomationRunner(deps);
    await sleep(10);

    enqueueRun("a", null, "manual");
    enqueueRun("a", null, "manual"); // deduped — already queued
    enqueueRun("b", null, "manual");

    await sleep(200);
    expect(deps.executed.map((e) => e.id)).toEqual(["a", "b"]);
    // Concurrency 1: b started only after a finished (30ms each, serial).
  });

  it("boot recovery marks stale running runs as interrupted errors", async () => {
    state.staleRuns.push({ id: "r-stale", sessionId: "s1", status: "running" });
    startAutomationRunner(makeDeps());
    await sleep(50);
    expect(state.runUpdates.some((u) => u.error === "interrupted by app quit")).toBe(true);
    expect(state.sessionUpdates.some((u) => u.statusError === "interrupted by app quit")).toBe(
      true,
    );
  });

  it("re-enqueues an automation after its previous run completed", async () => {
    const deps = makeDeps();
    startAutomationRunner(deps);
    await sleep(10);

    enqueueRun("a", null, "manual");
    await sleep(80); // a finished
    enqueueRun("a", "second fire", "poll");
    await sleep(80);
    expect(deps.executed.map((e) => e.id)).toEqual(["a", "a"]);
    expect(deps.executed[1].context).toBe("second fire");
  });
});
