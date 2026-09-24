import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectToolSequence } from "../infra/assert";

/**
 * Parameters the model must NOT be shown, and aliases it must still be able to
 * send.
 *
 * TWO CLASSES, ONE MECHANISM
 * --------------------------
 * 1. **Harness-injected.** `workspace`, `workspaceId` and `workspaceSessionId`
 *    were advertised on `grep`, `plan`, `automations` and `session_search`, and
 *    the branches inject them by spreading `...tc.args` and THEN overwriting —
 *    so whatever the model sent was discarded. The model was paying tokens for
 *    parameters it could not affect, and being invited to guess a workspace id.
 *    `chatMode` and `_chatSessionId` were already injected without being
 *    advertised; this makes the other three consistent with them.
 * 2. **Legacy aliases.** `read_file.file_path`, `read_file.max_lines` /
 *    `start_line` / `end_line`, `background_jobs.job_id`, `web_search.mode` and
 *    `ask_user.choices` each duplicate a parameter that already exists. Every
 *    near-duplicate is a way to call a tool wrongly, and `system_prompt.ts`
 *    records that we deliberately stopped paying prompt tokens to fight the
 *    `path`/`file_path` prior once `guard.ts` canonicalised it — advertising the
 *    alias undid that.
 *
 * The rule for class 2 is **stop advertising, keep accepting**. A model with a
 * strong training prior will send `file_path` or `start_line` regardless of what
 * the schema says, and a tool that then failed would be a regression dressed up
 * as a saving. Tool schemas carry no `additionalProperties: false`, so an
 * unknown property reaches the handler — but that is the kind of claim that
 * deserves a test rather than a paragraph, which is what the second half of this
 * file is.
 */

let ctx: EvalContext;

/** Distinct per line so a slice assertion cannot pass by accident. */
const SEEDED = [
  "line-one-alpha",
  "line-two-bravo",
  "line-three-charlie",
  "line-four-delta",
  "line-five-echo",
].join("\n");

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/lines.ts": `${SEEDED}\n` },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

type WireTool = {
  name?: string;
  parameters?: { properties?: Record<string, unknown> };
  function?: {
    name?: string;
    parameters?: { properties?: Record<string, unknown> };
  };
};

/** Every advertised property name, per tool, from the dispatched request. */
function advertisedProperties(scenarioId: string): Map<string, Set<string>> {
  const requests = ctx.server.requestsFor(scenarioId) as Array<{
    tools?: WireTool[];
  }>;
  const body = requests[0];
  if (!body) throw new Error(`No request recorded for "${scenarioId}"`);
  const out = new Map<string, Set<string>>();
  for (const t of body.tools ?? []) {
    const name = t.function?.name ?? t.name ?? "?";
    const props =
      t.function?.parameters?.properties ?? t.parameters?.properties ?? {};
    out.set(name, new Set(Object.keys(props)));
  }
  return out;
}

/** The text of the LAST request — where a tool result has landed by then. */
function lastRequestText(scenarioId: string): string {
  const requests = ctx.server.requestsFor(scenarioId) as unknown[];
  expect(requests.length).toBeGreaterThanOrEqual(2);
  return JSON.stringify(requests[requests.length - 1]);
}

const INJECTED = ["workspace", "workspaceId", "workspaceSessionId"] as const;

/** tool → aliases that must no longer appear in its advertised schema. */
const RETIRED_ALIASES: Record<string, readonly string[]> = {
  read_file: ["file_path", "max_lines", "start_line", "end_line"],
  background_jobs: ["job_id"],
  web_search: ["mode", "deep", "sources", "max_sources"],
  browser: ["target"],
  browser_inspect: ["target"],
  ask_user: ["choices"],
};

describe("unadvertised parameters", () => {
  it("advertises no harness-injected parameter, on any tool", async () => {
    const id = "up-injected";
    ctx.server.register(scenario(id).text("ok.").build());
    const chatId = await ctx.newChat();
    await runTurn(ctx, { chatId, prompt: `sc=${id} hello`, mode: "build" });

    const advertised = advertisedProperties(id);
    expect(advertised.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const [tool, props] of advertised) {
      for (const p of INJECTED) {
        if (props.has(p)) offenders.push(`${tool}.${p}`);
      }
    }
    expect(
      offenders,
      "these are overwritten by the branch after `...tc.args`, so the model " +
        "cannot affect them and must not be shown them",
    ).toEqual([]);
  }, 30_000);

  it("advertises no retired alias", async () => {
    const id = "up-aliases";
    ctx.server.register(scenario(id).text("ok.").build());
    const chatId = await ctx.newChat();
    await runTurn(ctx, { chatId, prompt: `sc=${id} hello`, mode: "build" });

    const advertised = advertisedProperties(id);
    const offenders: string[] = [];
    for (const [tool, aliases] of Object.entries(RETIRED_ALIASES)) {
      const props = advertised.get(tool);
      if (!props) continue; // not bound in this mode — nothing to assert
      for (const a of aliases) {
        if (props.has(a)) offenders.push(`${tool}.${a}`);
      }
    }
    expect(offenders).toEqual([]);

    // The canonical parameters that REPLACE them must still be advertised, or
    // this test would pass just as well against a tool with no schema at all.
    expect(advertised.get("read_file")).toBeDefined();
    for (const kept of ["path", "offset", "limit"]) {
      expect(
        advertised.get("read_file")!.has(kept),
        `read_file must still advertise ${kept}`,
      ).toBe(true);
    }
  }, 30_000);

  it("still EXECUTES the `file_path` alias it no longer advertises", async () => {
    const id = "up-file-path";
    ctx.server.register(
      scenario(id)
        // The alias, not `path` — the spelling a training prior produces.
        .toolCall("read_file", { file_path: "src/lines.ts" })
        .text("read it.")
        .repeatLast()
        .build(),
    );
    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: `sc=${id} read the file`,
      mode: "build",
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectToolSequence(fakeIpc.sends, ["read_file"]);
    expect(
      lastRequestText(id),
      "an unadvertised alias must still reach the handler — otherwise this is " +
        "a regression wearing a saving's clothes",
    ).toContain("line-one-alpha");
  }, 30_000);

  it("still EXECUTES `start_line`/`end_line`, and they still slice", async () => {
    const id = "up-line-range";
    ctx.server.register(
      scenario(id)
        .toolCall("read_file", {
          path: "src/lines.ts",
          start_line: 2,
          end_line: 3,
        })
        .text("read the range.")
        .repeatLast()
        .build(),
    );
    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: `sc=${id} read lines 2-3`,
      mode: "build",
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    const text = lastRequestText(id);
    // Present: the requested range.
    expect(text).toContain("line-two-bravo");
    expect(text).toContain("line-three-charlie");
    // Absent: proof the range was HONOURED rather than the whole file returned,
    // which would make the two assertions above pass for the wrong reason.
    expect(text).not.toContain("line-five-echo");
  }, 30_000);
});
