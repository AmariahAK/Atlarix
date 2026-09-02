import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { exactTokenCountText } from "@/lib/context/token-counter";

/**
 * The FIXED prompt prefix, per mode, measured on the wire.
 *
 * WHY A CEILING AND NOT A SNAPSHOT
 * --------------------------------
 * The prefix grows by accident. Guidance moves onto a tool description because
 * descriptions are progressive (correct, and documented in mode-prompt-bundle),
 * a parameter gains a paragraph, a mode header gains a correction — each one
 * defensible, and the sum was 14,232 tokens in Build before anyone measured it,
 * against a context meter reporting 3,986. A ceiling makes the total something
 * a change has to answer for.
 *
 * WHY IT READS THE REQUEST BODY
 * -----------------------------
 * The same reason `toolset-golden` does: this asserts on what DISPATCHED, not
 * on what a builder returned when a test called it directly. The meter's whole
 * defect was that it measured a shape no stream had ever sent — a prompt built
 * with no mode, which renders all five mode blocks. Reading `body.messages` +
 * `body.tools` cannot make that mistake.
 *
 * The tokenizer is `exactTokenCountText` — the SAME function the context meter
 * uses. If it were a different one the eval and the meter could disagree about
 * the number while both were "right", which is the situation this work exists
 * to end.
 *
 * WHEN THIS FAILS
 * ---------------
 * A rise is a conscious decision: either the addition earns its tokens and the
 * ceiling moves with a note saying why, or it does not and it comes back out.
 * A FALL below `floor` is also a failure — it means a mode quietly stopped
 * binding something (an allowlist regression looks exactly like a saving), and
 * silence on that is how you ship Explore with no `run_command`.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/app.ts": "export const app = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

type PrefixMeasurement = {
  systemTokens: number;
  toolDescriptionTokens: number;
  toolSchemaTokens: number;
  toolCount: number;
  total: number;
};

type WireRequest = {
  messages?: Array<{ role?: string; content?: unknown }>;
  system?: unknown;
  tools?: Array<{
    name?: string;
    description?: string;
    parameters?: unknown;
    function?: { name?: string; description?: string; parameters?: unknown };
  }>;
};

/** Flatten whatever shape a provider accepts for message content into text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * Measure the first dispatched request of a scenario.
 *
 * The FIRST request only: later steps in the same turn carry tool results, and
 * the point here is the fixed cost a turn opens with.
 */
function measureFirstRequest(scenarioId: string): PrefixMeasurement {
  const requests = ctx.server.requestsFor(scenarioId) as WireRequest[];
  const body = requests[0];
  if (!body) {
    throw new Error(
      `No request recorded for scenario "${scenarioId}" — the turn never dispatched.`,
    );
  }

  // The stable header rides the `system` field and the per-turn tail is
  // prepended as a system-role message (see constructSystemPromptParts), so
  // both have to be counted or the split itself hides tokens.
  const systemFromField = contentToText(body.system);
  const systemFromMessages = (body.messages ?? [])
    .filter((m) => m?.role === "system")
    .map((m) => contentToText(m.content))
    .join("\n");
  const systemTokens = exactTokenCountText(
    [systemFromField, systemFromMessages].filter(Boolean).join("\n"),
  );

  let toolDescriptionTokens = 0;
  let toolSchemaTokens = 0;
  const tools = body.tools ?? [];
  for (const t of tools) {
    const description = t.function?.description ?? t.description ?? "";
    const parameters = t.function?.parameters ?? t.parameters ?? {};
    toolDescriptionTokens += exactTokenCountText(description);
    toolSchemaTokens += exactTokenCountText(JSON.stringify(parameters) ?? "");
  }

  return {
    systemTokens,
    toolDescriptionTokens,
    toolSchemaTokens,
    toolCount: tools.length,
    total: systemTokens + toolDescriptionTokens + toolSchemaTokens,
  };
}

/**
 * Ceilings and floors, per mode.
 *
 * MEASURED 2026-09-02, on the wire, at each step:
 *
 *          v14.40.0  schema/reveal  browser 6→2  mobile (build only)  mobile EVERY mode
 *   ask     11,539      10,864        10,386           10,404              10,875
 *   plan    10,891      10,313         9,835            9,839              10,310
 *   build   15,329      14,616        14,174           14,605              14,644
 *   review  11,199      10,524        10,046           10,055              10,526
 *   debug   14,738      14,025        13,583           14,014              14,053
 *
 * The last column is a DELIBERATE trade, not a regression. `mobile_inspect` +
 * `mobile` were briefly build/debug-only; they are now every mode, because
 * neither touches the workspace and "what does this look like on a phone" is a
 * question, not a build step. That costs the read-only modes ~471 tokens each.
 *
 * Every mode still lands below where it started — ask −664, plan −581,
 * build −685, review −673, debug −685 — while the browser surface shrank from
 * six tools to two and Atlarix gained the ability to see a device at all.
 *
 * WHERE THE 471 ACTUALLY GOES, since it is the interesting part: descriptions
 * +140, parameter SCHEMAS +318. Both tools are peripheral under `tool-reveal`,
 * so that 140 is already just a first sentence plus a `tool_help` pointer —
 * reveal is working. The schemas are the residue, because reveal trims parameter
 * PROSE and deliberately keeps every parameter, type, enum and default. Anyone
 * trying to shave this further should start there, not at the descriptions.
 *
 * The ceilings track the LAST column: a ceiling left at an old, larger number is
 * a ratchet that only ever loosens, so it moves whenever the prefix does — down
 * after a reduction, and up ONLY with a line here saying what was bought.
 *
 * These run ~1,100 above a bare `constructSystemPromptParts` measurement of the
 * same mode, because a real dispatch also carries the mode reanchor and the
 * ContextAssembler's project-instruction and skills-index pointers. That gap IS
 * the reason to measure here rather than by calling the builder directly.
 *
 * `maxTotal` is the baseline + ~8%, so a one-line addition does not fail the
 * build but a paragraph does. `minTotal` is the baseline − ~15%.
 *
 * Expect a few tokens of run-to-run jitter (build measured 15,329 and 15,323 on
 * consecutive runs): the prefix carries the workspace's own temp path and a date
 * stamp. Don't chase a single-digit difference; the headroom exists for it.
 */
const BUDGET: Record<string, { minTotal: number; maxTotal: number }> = {
  ask: { minTotal: 9_250, maxTotal: 11_750 },
  plan: { minTotal: 8_750, maxTotal: 11_150 },
  build: { minTotal: 12_450, maxTotal: 15_800 },
  review: { minTotal: 8_950, maxTotal: 11_350 },
  debug: { minTotal: 11_950, maxTotal: 15_150 },
};

const CASES = [
  { key: "ask", mode: "ask" as const, settings: undefined },
  {
    key: "plan",
    mode: "ask" as const,
    settings: { workModePreference: "plan" } as const,
  },
  { key: "build", mode: "build" as const, settings: undefined },
  {
    key: "review",
    mode: "ask" as const,
    settings: { workModePreference: "review" } as const,
  },
  {
    key: "debug",
    mode: "build" as const,
    settings: { workModePreference: "debug" } as const,
  },
];

describe("prompt budget — the fixed prefix, on the wire", () => {
  const measured: Record<string, PrefixMeasurement> = {};

  for (const c of CASES) {
    it(`${c.key} stays inside its prefix budget`, async () => {
      const id = `pb-${c.key}`;
      ctx.server.register(scenario(id).text("ok done.").build());
      const chatId = await ctx.newChat();
      await runTurn(ctx, {
        chatId,
        prompt: `sc=${id} hello`,
        mode: c.mode,
        ...(c.settings ? { settings: c.settings } : {}),
      });

      const m = measureFirstRequest(id);
      measured[c.key] = m;

      const budget = BUDGET[c.key]!;
      // The message names the split, because "the prefix grew by 900" is not
      // actionable and "tool schemas grew by 900" is.
      const detail =
        `${c.key}: total=${m.total} ` +
        `(system=${m.systemTokens} descriptions=${m.toolDescriptionTokens} ` +
        `schemas=${m.toolSchemaTokens} over ${m.toolCount} tools)`;

      expect(m.toolCount, `${detail} — no tools bound at all`).toBeGreaterThan(0);
      expect(m.total, `${detail} — ABOVE ceiling ${budget.maxTotal}`).toBeLessThanOrEqual(
        budget.maxTotal,
      );
      expect(
        m.total,
        `${detail} — BELOW floor ${budget.minTotal}; a mode that stopped binding ` +
          `something looks exactly like a saving`,
      ).toBeGreaterThanOrEqual(budget.minTotal);
    }, 30_000);
  }

  it("records the measured prefix for every mode", () => {
    // Not an assertion so much as the artefact: the numbers a changelog entry
    // and the next ceiling revision are written from.
    const rows = Object.entries(measured)
      .map(
        ([mode, m]) =>
          `  ${mode.padEnd(7)} total=${String(m.total).padStart(6)}  ` +
          `system=${String(m.systemTokens).padStart(5)}  ` +
          `desc=${String(m.toolDescriptionTokens).padStart(5)}  ` +
          `schemas=${String(m.toolSchemaTokens).padStart(5)}  ` +
          `tools=${m.toolCount}`,
      )
      .join("\n");
    console.log(`[prompt-budget] dispatched prefix per mode:\n${rows}`);
    expect(Object.keys(measured).length).toBe(CASES.length);
  });
});
