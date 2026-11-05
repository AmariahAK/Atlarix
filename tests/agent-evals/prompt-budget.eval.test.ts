import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
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
 * MEASURED 2026-09-07, after the desktop computer-use tools were DELETED:
 *
 *          mobile EVERY mode   now      delta   ceiling   headroom
 *   ask         10,875        10,901     +26    11,800      899
 *   plan        10,310        10,336     +26    11,200      864
 *   build       14,644        14,668     +24    15,850    1,182
 *   review      10,526        10,552     +26    11,400      848
 *   debug       14,053        14,077     +24    15,250    1,173
 *
 * `computer` + `computer_inspect` + `computer_call` are gone, giving back 780 in
 * each read-only mode and 762 in build/debug. The +26/+24 against the last
 * pre-computer column is unrelated prefix drift over the same period, not a
 * regression — the prefix is now within ~26 tokens of where it stood before the
 * feature existed.
 *
 * THE CEILINGS MOVE DOWN, which is the ratchet working in the direction it almost
 * never gets to. They were raised for `computer_call` on the argument that the
 * addition had earned it; that addition is gone, so the slack goes with it rather
 * than being inherited by whatever lands next. Reset to baseline + 8% per the rule
 * below. The next read-only-mode addition pays for its own room.
 *
 * The v14.41 note, kept because its prediction came true:
 *
 * AND IT COST MORE THAN PLANNED — the design targeted ~350/mode and it came in at
 * ~524. Same split as before: the parameter SCHEMAS are the residue, since reveal
 * trims prose and keeps every parameter, type and enum. One lever was already
 * pulled (`button` folded into the `action` enum, worth 22), and the remaining ones
 * are the same shape: fold a variant into an enum rather than adding a parameter.
 *
 * These run ~1,100 above a bare `constructSystemPromptParts` measurement of the
 * same mode, because a real dispatch also carries the mode reanchor and the
 * ContextAssembler's project-instruction and skills-index pointers. That gap IS
 * the reason to measure here rather than by calling the builder directly.
 *
 * MEASURED 2026-09-22 — read-only modes stop lying, and Plan gains run_command.
 *
 * Measured BOTH SIDES at the same commit rather than against the column above,
 * because that column is from 2026-09-07 and the prefix drifted ~600 tokens over
 * the releases since. A delta against a stale number is not a delta.
 *
 *              HEAD before    after    delta   ceiling   headroom
 *   ask           11,527     11,150    −377    11,800      650
 *   plan          10,962      9,879  −1,083    11,200    1,321
 *   build         15,243     15,092    −151    15,850      758
 *   review        11,178     11,048    −130    11,400      352
 *   debug         14,652     14,501    −151    15,250      749
 *   build-fr      15,285     15,134    −151    15,950      816
 *
 * WHAT WAS BOUGHT. Plan gained `run_command` and `background_jobs`. It was
 * expected to produce an informed plan while unable to run `git log`, `ls` or a
 * typecheck — so it inferred what it could have checked. (It was also already
 * paying for `run_command` in the worst way: `allowInAskMode` let a hallucinated
 * call EXECUTE, into the profile that could not run a build.)
 *
 * WHAT PAID FOR IT, in the order applied, each defensible on its own merits:
 *
 *  1. `automations` and `manage_mcp_server` out of PLAN_TOOLS. Both are ACTS, and
 *     a plan describes an act rather than performing one — `mcp.ts` calls adding
 *     a stdio server "approving arbitrary process execution at the user's
 *     privilege". `list_available_mcps` stays, so Plan can still see and plan
 *     around what exists.
 *  2. `background_jobs` PERIPHERAL in Plan, unlike Build. Its core billing there
 *     is that a foreground command auto-promotes after ~15s and the model must
 *     know the mechanism — but `run_command`'s own description says exactly that,
 *     and in Plan `run_command` is core. Paying for the text twice is what the
 *     reveal stage exists to avoid.
 *  3. The mobile pair out of Plan (MODE_EXCLUDED_TOOLS). EVERY_MODE_TOOLS
 *     justifies them with "'what does the app look like on a phone' is a
 *     QUESTION" — which is Explore's job, not Plan's.
 *  3b. `browser` + `browser_inspect` out of Plan — 1,324 tokens, the largest
 *     single item, and a REVERSAL of what this change originally planned. The
 *     deciding fact was not the budget: `browser_inspect` cannot navigate, so
 *     keeping only the cheaper one would leave Plan able to inspect whatever
 *     page happened to be open and unable to open one. Driving and reading a
 *     running app is verification, which is Explore's job; Plan writes
 *     "verify X in Explore" as a step. See mode-tool-registry.ts for the full
 *     argument, including why the browser-guidance note in mode-prompt-bundle.ts
 *     does not forbid this.
 *  4. SCHEMA tiering split from DESCRIPTION tiering (tool-reveal.ts). `NEVER_TRIM`
 *     exists because a description can carry a correction the model must read
 *     before it decides; parameter PROSE carries no such correction, and every
 *     parameter, type, enum and default is kept either way. This is the one lever
 *     that pays in every mode, and it is where the budget note below already
 *     pointed: the schemas are the residue.
 *  5. Explore's mode block stopped re-teaching `run_command` — backgrounding, the
 *     localhost handoff, the sandbox, a "do not claim run_command is unavailable"
 *     nag — all of which live on the tool itself. Same consolidation this file
 *     performed on GIT_VIA_TERMINAL_NOTE and BROWSER_NOTE, for the same reason.
 *     Deleting it also removed a FALSE promise: it told the model dependency
 *     installs worked, and under the old read-only profile they could not.
 *  6. `run_command`'s own description tightened (~700 chars), which is a discount
 *     on all five modes since it is core in every one.
 *
 * Net: EVERY mode came down, Plan most of all. It gained the ability to check
 * what it is planning against and still ended 1,083 tokens lighter than it
 * started, because what it gave up — acts it should only ever describe, and a
 * running app it has no business driving — was worth more than what it gained
 * was expensive. THE CEILINGS DO NOT MOVE. Plan's headroom is real slack now
 * rather than the 33 tokens an earlier round of this squeaked under with, and a
 * margin that thin is not a pass: this file's own note warns the prefix jitters
 * by a few tokens per run.
 *
 * `maxTotal` is the baseline + ~8%, so a one-line addition does not fail the
 * build but a paragraph does. `minTotal` is the baseline − ~15%.
 *
 * Expect a few tokens of run-to-run jitter (build measured 15,329 and 15,323 on
 * consecutive runs): the prefix carries the workspace's own temp path and a date
 * stamp. Don't chase a single-digit difference; the headroom exists for it.
 */
// Re-based 2026-10-18 after the prompt diet (owner: "why are we overprompting
// when LLMs are becoming better, cheaper and more efficient"): every mode lost
// 1,800-2,000 tokens with the same tools bound. Baselines: ask 8,512, plan 6,953,
// build 10,439, review 8,180, debug 10,692, build-fr 10,481.
// 2026-10-21, owner-approved memory rework: the "Project memory" rules moved from
// the guides/memory file into the cached header, +377 (build/debug) to +417 tokens
// per mode, and the per-turn index section left the system block. Ceilings unchanged.
// 15.11 (2026-10-23): the mobile pair was deleted. Measured before → after:
// ask 9,000 → 8,497, plan 7,427 → 7,426 (it never had them), build 10,916 → 10,423
// (33 → 31 tools), review 8,668 → 8,165, debug 11,169 → 10,676. Every ceiling except
// Plan's came down 500 with it (TRAPS: a ceiling left high only loosens).
// 2026-11-05, owner-directed: review mode's "How to work" steps became global
// (every mode; Review keeps only its code-change part, and Zenith needs no
// prompt of its own). Measured after: ask 8,983, plan 7,943, build 10,901,
// review 8,667, debug 11,154, build-fr 10,941; plan was +422 (7,521 before,
// already 21 over its 7,500 ceiling on main). Each ceiling moved by that much,
// keeping its old headroom.
const BUDGET: Record<string, { minTotal: number; maxTotal: number }> = {
  ask: { minTotal: 7_250, maxTotal: 9_200 },
  plan: { minTotal: 5_900, maxTotal: 8_050 },
  build: { minTotal: 8_850, maxTotal: 11_200 },
  // 11,400 → 11,500 on 2026-10-13, owner-approved: glob's `sort: "size"` option
  // (~45 tokens) put Review at 11,429. Paid for by raising this ceiling, NOT by
  // rewording shared tool text, which the app, CLI and editors all run on.
  review: { minTotal: 6_950, maxTotal: 8_850 },
  debug: { minTotal: 9_100, maxTotal: 11_500 },
  // A NON-ENGLISH case, because every other case runs in English and the response
  // language block is emitted ONLY when the locale is not en-us. Without this the
  // suite would never see the instruction at all, its cost would be unmeasured,
  // and the feature could ship silently dead — the block could stop being emitted
  // and nothing here would notice.
  "build-fr": { minTotal: 8_900, maxTotal: 11_250 },
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
  {
    key: "build-fr",
    mode: "build" as const,
    settings: { appLanguage: "fr" } as const,
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

      expect(m.toolCount, `${detail} — no tools bound at all`).toBeGreaterThan(
        0,
      );
      expect(
        m.total,
        `${detail} — ABOVE ceiling ${budget.maxTotal}`,
      ).toBeLessThanOrEqual(budget.maxTotal);
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

  it("EMITS the response-language block on a non-English locale", () => {
    // The ceiling check alone cannot catch this. If the block stopped being
    // emitted — a renamed setting, a resolver returning en-us, a filter dropping
    // an empty string — `build-fr` would simply equal `build` and every budget
    // assertion would still pass, while the feature was silently dead. The DELTA
    // is the only thing that proves it reached the wire.
    const base = measured["build"]!;
    const fr = measured["build-fr"]!;
    expect(
      fr.total - base.total,
      `build-fr (${fr.total}) must exceed build (${base.total}) — the response ` +
        `language instruction is not reaching the dispatched prompt`,
    ).toBeGreaterThan(20);
    // It belongs in the SYSTEM prefix, not in tool descriptions or schemas.
    expect(fr.systemTokens).toBeGreaterThan(base.systemTokens);
    expect(fr.toolDescriptionTokens).toBe(base.toolDescriptionTokens);
    expect(fr.toolSchemaTokens).toBe(base.toolSchemaTokens);
  });
});
