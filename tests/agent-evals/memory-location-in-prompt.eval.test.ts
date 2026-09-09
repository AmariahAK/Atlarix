import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { appendIndexLine, memoryDirFor } from "@/lib/agent-memory";
import { chatModeForWorkMode } from "@/lib/work-mode";
import fs from "node:fs";
import path from "node:path";

/**
 * The memory store's location must reach the DISPATCHED system prompt — in every
 * mode.
 *
 * This exists because the unit tests could not catch how it first shipped. They
 * called `constructSystemPromptParts({ memoryDir })` directly, so they proved the
 * block renders the path *when given one* — and said nothing about whether any
 * production call site actually passes it. Build mode did (via
 * `buildSystemPromptWithProjectInstructions`). **Ask/Explore did not**: it rebuilds
 * its own header in `ask-branch`'s `buildRoundSystemPrompt`, and that call omitted
 * the argument. So the path was published in Build and Debug and silently missing
 * in exactly the read-only modes where an agent is most likely to go hunting — which
 * is what a real DeepSeek V4 Pro session then did.
 *
 * So this asserts against the request the provider actually received. The fake
 * server records raw request bodies, which makes the system prompt observable, and
 * that is the only thing here that cannot pass for the wrong reason.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/x.ts": "export const x = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Every system-role message in the first recorded request, concatenated. */
function dispatchedSystemText(scenarioId: string): string {
  const reqs = ctx.server.requestsFor(scenarioId) as Array<{
    messages?: Array<{ role?: string; content?: unknown }>;
  }>;
  expect(
    reqs.length,
    "no request recorded — the turn never dispatched",
  ).toBeGreaterThan(0);
  return (reqs[0].messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
}

describe("memory location reaches the dispatched prompt", () => {
  /**
   * ALL FIVE work modes, not just the two branch families.
   *
   * The routing is not obvious — `chatModeForWorkMode` sends **build** to the build
   * branch and **explore, plan, debug and review** to the ask branch, so four of the
   * five ran through the one call site that was missing the argument. Rather than
   * encode that mapping here (where it would silently drift if routing changed), the
   * test imports it: each mode is driven exactly the way `settingsPatchForWorkMode`
   * drives it in the app.
   */
  const MODES = ["ask", "plan", "build", "debug", "review"] as const;

  for (const workMode of MODES) {
    const chatMode = chatModeForWorkMode(workMode);
    it(`is published in ${workMode} mode (chatMode=${chatMode})`, async () => {
      const id = `mem-${workMode}`;
      ctx.server.register(scenario(id).text("Done.").repeatLast().build());

      const chatId = await ctx.newChat();
      await runTurn(ctx, {
        chatId,
        prompt: `sc=${id} Say hello.`,
        mode: chatMode,
        // Mirrors `settingsPatchForWorkMode` — the same three fields the picker sets.
        settings: {
          workModePreference: workMode,
          selectedChatMode: chatMode,
          intentMode: chatMode,
        },
        timeoutMs: 30_000,
      });

      const system = dispatchedSystemText(id);
      const expected = memoryDirFor(ctx.ws.dir);

      // The resolved absolute path, not a template. A `<slug>` placeholder is the
      // shape that started this whole problem: a fillable path is an invitation to
      // complete it, and the completion is where the stale copy came from.
      expect(system).toContain(expected);
      expect(system).not.toContain("<slug>");

      // And stated as the ONLY store, so searching for another is obviously wrong.
      expect(system).toMatch(/only store/i);
      expect(system).toMatch(/nowhere else/i);
    });
  }

  /**
   * A store that does not exist yet is the case that MATTERS most.
   *
   * The old empty-state section existed precisely because a fresh workspace was told
   * nothing, so the agent invented a path and the first note landed outside the
   * store — which kept the store empty, which kept the section hidden. Deleting that
   * section is only safe if the identity block names the directory whether or not
   * anything is in it. Every mode case above already runs on a fresh temp workspace,
   * so they are all empty-store cases; this states it outright so the property
   * cannot be lost by someone later seeding memory in the fixture.
   */
  it("names the directory for a store that does not exist yet", async () => {
    const dir = memoryDirFor(ctx.ws.dir);
    expect(
      fs.existsSync(dir),
      "fixture precondition: the store must NOT exist",
    ).toBe(false);

    const id = "mem-fresh";
    ctx.server.register(scenario(id).text("Done.").repeatLast().build());
    const chatId = await ctx.newChat();
    await runTurn(ctx, {
      chatId,
      prompt: `sc=${id} Say hello.`,
      mode: "ask",
      timeoutMs: 30_000,
    });

    expect(dispatchedSystemText(id)).toContain(dir);
  });

  it("still names it once notes exist", async () => {
    // The other half: a populated store must not lose the path when the per-turn
    // section takes over — the section no longer carries it at all.
    // Written through the app's OWN writer, not by hand: `appendIndexLine` is what
    // creates the index in the shape the reader expects, and a hand-rolled MEMORY.md
    // is a fixture that tests my formatting rather than the product's.
    const dir = memoryDirFor(ctx.ws.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a-fact.md"), "# a fact\n", "utf8");
    await appendIndexLine(ctx.ws.dir, "- [A fact](a-fact.md) — a hook");
    try {
      const id = "mem-populated";
      ctx.server.register(scenario(id).text("Done.").repeatLast().build());
      const chatId = await ctx.newChat();
      await runTurn(ctx, {
        chatId,
        prompt: `sc=${id} Say hello.`,
        mode: "ask",
        timeoutMs: 30_000,
      });

      // The PATH is the property this file exists to protect, and it must survive
      // the store becoming populated — the per-turn section stopped carrying it, so
      // if the identity block ever dropped it, a populated workspace would be the
      // case that silently lost it.
      expect(dispatchedSystemText(id)).toContain(dir);

      // NOT asserted here: that the index CONTENT arrives. A control run showed no
      // ContextAssembler section (project instructions included) is observable in a
      // recorded request in EITHER branch, so this harness cannot tell "dropped"
      // from "not observable" — asserting it would pin a harness artefact rather
      // than product behaviour. The index is covered at the unit level, where the
      // section's own output is inspected directly:
      // `src/__tests__/memory-location-is-published.test.ts`.
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts it in the opening block, not buried after the procedure", async () => {
    const id = "mem-position";
    ctx.server.register(scenario(id).text("Done.").repeatLast().build());

    const chatId = await ctx.newChat();
    await runTurn(ctx, {
      chatId,
      prompt: `sc=${id} Say hello.`,
      mode: "ask",
      timeoutMs: 30_000,
    });

    const system = dispatchedSystemText(id);
    const at = system.indexOf(memoryDirFor(ctx.ws.dir));
    const toolContractAt = system.indexOf("<tool_contract>");

    // Position was the entire point of the change: measured before it, the line sat
    // 94% of the way through a 14k-character header — orienting information arriving
    // after all the procedure.
    expect(at).toBeGreaterThan(-1);
    if (toolContractAt > -1) expect(at).toBeLessThan(toolContractAt);
    expect(at / system.length).toBeLessThan(0.35);
  });
});
