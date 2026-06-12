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
// v13: opencode-minimal surface — 22 registered tools total.
const GOLDEN = {
  ask: [
    "ask_user", "browser_navigate", "browser_read_page", "browser_screenshot",
    "compress_context", "get_blueprint", "glob", "grep", "list_attachments",
    "list_available_mcps", "mcp_call", "read_attachment", "read_file",
    "read_url", "run_command", "task", "web_search",
  ],
  plan: [
    "ask_user", "browser_navigate", "browser_read_page", "browser_screenshot",
    "compress_context", "get_blueprint", "glob", "grep", "list_attachments",
    "list_available_mcps", "mcp_call", "plan", "read_attachment", "read_file",
    "read_url", "task", "web_search",
  ],
  build: [
    "ask_user", "browser_click", "browser_fill", "browser_navigate",
    "browser_read_page", "browser_screenshot", "compress_context", "edit_file",
    "get_blueprint", "glob", "grep", "list_attachments", "list_available_mcps",
    "mcp_call", "plan", "read_attachment", "read_file", "read_url",
    "run_command", "task", "web_search", "write_file",
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
        scenario(`tg-${c.key}`).text("ok <task_complete>").build(),
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
