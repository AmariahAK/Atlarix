import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";

/**
 * v12 S19 (closes 3.10) — the EXACT offered-toolset contract per mode, pinned
 * after `resolveToolsetForSession` unified the two assembly sites. These
 * lists were captured pre-refactor and verified byte-identical post-refactor.
 *
 * A diff here is a CONTRACT CHANGE: adding/removing a tool or touching the
 * resolution pipeline (mode allowlist, loader seed, capability trim,
 * plan-tool union, delegation attach) must update the golden CONSCIOUSLY —
 * that's the point.
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

function offeredToolNames(scenarioId: string): string[] {
  const requests = ctx.server.requestsFor(scenarioId) as Array<{
    tools?: Array<{ function?: { name?: string }; name?: string }>;
  }>;
  return [...(requests[0]?.tools ?? [])]
    .map((t) => t.function?.name ?? t.name ?? "?")
    .sort();
}

// Workspace turns, strong (default) model — the full surface per mode.
// v13.7: get_blueprint removed (Blueprint is now the silent grep substrate).
// v13.8: browser tools consolidated 6→3 (browser_inspect/browser_interact/
// browser_navigate); write_file merged into edit_file (operation:"write").
// v14.16: browser_tabs / browser_find / browser_batch added (multi-tab, find by
// description, batched actions) — the ergonomic gaps vs reference toolkits.
// v14.21: `subagents` is EVERY mode (Plan delegates read-only recon, so it must
// be able to list/read/cancel it); `proposals` is build/debug only, because
// accepting one ends in a real workspace write.
// v14.27: `automations` is EVERY mode. An automation is not a workspace
// mutation, its mutating operations go through the approval gate, and `list`
// from a read-only mode is the point — Explore is where the user is most likely
// to be doing by hand the repeated check that should become an automation.
// v14.41: six browser_* tools became TWO. `browser_inspect` reads (and stays
// separate — it is the sole NEVER_TRIM entry, its wording steers away from an
// observed bug); `browser` acts, with navigate/find/click/fill/key/hover/
// scroll/tabs/batch as an `action`. The retired names still RESOLVE as aliases,
// but aliases are deliberately not advertised, so they must not appear here.
// v14.41: `mobile_inspect` + `mobile` added to EVERY mode, for the same reason
// `browser` is in every mode — neither touches the workspace (driving an
// emulator changes a device's state, not the project), and "what does this look
// like on a phone" is a question, not a build step. They were briefly
// build/debug-only; that was the wrong cut.
// Net for Build: 6 browser tools + 0 mobile → 2 browser + 2 mobile, i.e. a
// SMALLER surface that can also see the app it is building. Both are peripheral
// under tool-reveal in EVERY mode, so each binds one sentence plus a tool_help
// pointer — which is why those first sentences carry the cheap default.
const GOLDEN = {
  ask: [
    "ask_user",
    "automations",
    "background_jobs",
    "browser",
    "browser_inspect",
    "compress_context",
    "glob",
    "grep",
    "list_attachments",
    "list_available_mcps",
    "mcp_call",
    "mobile",
    "mobile_inspect",
    "read_attachment",
    "read_file",
    "read_url",
    "run_command",
    "schedule_wakeup",
    "session_search",
    "subagents",
    "task",
    "tool_help",
    "web_search",
  ],
  plan: [
    "ask_user",
    "automations",
    "browser",
    "browser_inspect",
    "compress_context",
    "glob",
    "grep",
    "list_attachments",
    "list_available_mcps",
    "mcp_call",
    "mobile",
    "mobile_inspect",
    "plan",
    "read_attachment",
    "read_file",
    "read_url",
    "schedule_wakeup",
    "session_search",
    "subagents",
    "task",
    "tool_help",
    "web_search",
  ],
  build: [
    "ask_user",
    "automations",
    "background_jobs",
    "browser",
    "browser_inspect",
    "browser_test",
    "compress_context",
    "edit_file",
    "glob",
    "grep",
    "list_attachments",
    "list_available_mcps",
    "mcp_call",
    "mobile",
    "mobile_inspect",
    "plan",
    "proposals",
    "read_attachment",
    "read_file",
    "read_url",
    "run_command",
    "schedule_wakeup",
    "session_search",
    "subagents",
    "task",
    "tool_help",
    "web_search",
  ],
} as const;

// review and debug were never pinned. They are byte-identical to ask and build
// respectively (mode-tool-registry: REVIEW_TOOLS mirrors ASK_TOOLS; debug shares
// build's "*" marker and differs by prompt discipline only) — so pinning them
// costs nothing and turns "they happen to match" into a contract.
const GOLDEN_ALIASES = {
  review: "ask",
  debug: "build",
} as const;

const CASES = [
  { key: "ask" as const, mode: "ask" as const, settings: undefined },
  {
    key: "plan" as const,
    mode: "ask" as const,
    settings: { workModePreference: "plan" } as const,
  },
  { key: "build" as const, mode: "build" as const, settings: undefined },
  {
    key: "review" as const,
    mode: "ask" as const,
    settings: { workModePreference: "review" } as const,
  },
  {
    key: "debug" as const,
    mode: "build" as const,
    settings: { workModePreference: "debug" } as const,
  },
];

describe("toolset golden — resolveToolsetForSession contract (S19)", () => {
  for (const c of CASES) {
    it(`${c.key} offers exactly the golden surface`, async () => {
      ctx.server.register(scenario(`tg-${c.key}`).text("ok done.").build());
      const chatId = await ctx.newChat();
      await runTurn(ctx, {
        chatId,
        prompt: `sc=tg-${c.key} hello`,
        mode: c.mode,
        ...(c.settings ? { settings: c.settings } : {}),
      });
      const goldenKey =
        (GOLDEN_ALIASES as Record<string, keyof typeof GOLDEN>)[c.key] ??
        (c.key as keyof typeof GOLDEN);
      expect(offeredToolNames(`tg-${c.key}`)).toEqual([...GOLDEN[goldenKey]]);
    }, 30_000);
  }
});
