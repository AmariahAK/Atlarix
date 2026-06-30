import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  type EvalContext,
} from "../infra/turn";
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
const GOLDEN = {
  ask: [
    "ask_user", "background_jobs", "browser_inspect", "browser_interact",
    "browser_navigate", "compress_context", "glob", "grep", "list_attachments",
    "list_available_mcps", "mcp_call", "read_attachment", "read_file",
    "read_url", "run_command", "schedule_wakeup", "task", "web_search",
  ],
  plan: [
    "ask_user", "browser_inspect", "browser_interact", "browser_navigate",
    "compress_context", "glob", "grep", "list_attachments",
    "list_available_mcps", "mcp_call", "plan", "read_attachment", "read_file",
    "read_url", "schedule_wakeup", "task", "web_search",
  ],
  build: [
    "ask_user", "background_jobs", "browser_inspect", "browser_interact",
    "browser_navigate", "compress_context", "edit_file",
    "glob", "grep", "list_attachments", "list_available_mcps",
    "mcp_call", "plan", "preview_test", "read_attachment", "read_file",
    "read_url", "run_command", "schedule_wakeup", "task", "web_search",
  ],
} as const;

const CASES = [
  { key: "ask" as const, mode: "ask" as const, settings: undefined },
  {
    key: "plan" as const,
    mode: "ask" as const,
    settings: { workModePreference: "plan" } as const,
  },
  { key: "build" as const, mode: "build" as const, settings: undefined },
];

describe("toolset golden — resolveToolsetForSession contract (S19)", () => {
  for (const c of CASES) {
    it(`${c.key} offers exactly the golden surface`, async () => {
      ctx.server.register(
        scenario(`tg-${c.key}`).text("ok done.").build(),
      );
      const chatId = await ctx.newChat();
      await runTurn(ctx, {
        chatId,
        prompt: `sc=tg-${c.key} hello`,
        mode: c.mode,
        ...(c.settings ? { settings: c.settings } : {}),
      });
      expect(offeredToolNames(`tg-${c.key}`)).toEqual([...GOLDEN[c.key]]);
    }, 30_000);
  }
});
