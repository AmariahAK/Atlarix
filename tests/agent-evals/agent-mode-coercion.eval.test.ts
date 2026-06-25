import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import {
  expectToolSequence,
  expectStreamEnded,
  expectNoStreamError,
} from "../infra/assert";

/**
 * v12 0.1 Phase D — legacy "agent" chat mode coerces to BUILD.
 *
 * The vestigial agent path (ex chat_stream_handlers.ts L3901-4188) was
 * DELETED; persisted `selectedChatMode: "agent"` rows coerce to "build" in
 * readSettings (custom-command modeOverrides coerce at the accept set).
 *
 * This pins the post-deletion behavior the harness originally exposed as
 * bugs (see the single-tool-flow NOTE): the dead path double-dispatched
 * every turn (agent block THEN the build `else`) and its tool wrapper
 * injected no `workspace` arg. With coercion, an "agent" turn is exactly a
 * build turn:
 *  - SINGLE dispatch (request count is exactly tool round + final round);
 *  - workspace injection works (tool result carries real file content);
 *  - build toolset surface (write tools offered);
 *  - build termination semantics (a prose-only round ends the turn).
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: {
      "src/legacy.ts": 'export const legacy = "zamani";\n',
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

type RecordedRequest = {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
};

describe("agent mode coerces to build", () => {
  it("runs a single correctly-wired build turn", async () => {
    ctx.server.register(
      scenario("agent-coerce")
        .toolCall("read_file", { path: "src/legacy.ts" })
        .text("The legacy constant is zamani.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=agent-coerce What does src/legacy.ts export?",
      mode: "agent",
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectToolSequence(fakeIpc.sends, ["read_file"]);

    const requests = ctx.server.requestsFor("agent-coerce") as RecordedRequest[];
    // SINGLE dispatch: tool round + final prose round(s), nothing like a whole
    // re-dispatch. Natural termination adds at most one reconciling prose round
    // after the tool op, so ≤3; the deleted re-dispatch bug produced many more.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.length).toBeLessThanOrEqual(3);

    // Workspace injection: the tool executed against the real workspace —
    // the follow-up request carries the seeded file content.
    expect(JSON.stringify(requests[1])).toContain("zamani");

    // Build toolset surface: the write tool IS offered (ask would exclude it).
    // v13.8: write_file folded into edit_file (operation:"write").
    const tools = (requests[0].tools ?? [])
      .map((t) => t.function?.name)
      .filter((n): n is string => typeof n === "string");
    expect(tools).toContain("read_file");
    expect(tools).toContain("edit_file");
    expect(tools).not.toContain("write_file");

    // Build termination semantics: ended the turn and is
    // stripped from the persisted assistant content.
    expectStreamEnded(fakeIpc.sends, chatId);
    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const lastAssistant = [...(getStreamTransport(chatId)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toContain("The legacy constant is zamani.");
  });
});
