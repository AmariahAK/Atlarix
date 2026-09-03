/**
 * Mid-turn user messages, on the wire.
 *
 * The owner's ask was "not cancel just come in as my message": a message typed
 * while a turn runs should reach THAT turn, not be replayed as a new one. This
 * eval pins the two things a unit test cannot see — that the message actually
 * lands in the dispatched request body, and that it lands UNTAGGED while the
 * harness's own injections in the same step stay tagged.
 *
 * WHY UNTAGGED MATTERS ENOUGH TO TEST. `system-reminder.ts` sets the
 * convention: harness content rides `role:"user"` (providers reject
 * mid-conversation `role:"system"`) and the `<system-reminder>` tag is what
 * marks it as not-real-input — "only untagged user turns are real user input".
 * A mid-turn message from the user IS real user input, so it is the first
 * untagged injection on that seam. Wrap it by accident and nothing errors; the
 * model just quietly treats the user's words as an ambient harness nudge.
 *
 * NOT COVERED HERE, and deliberately: that the drain is not gated on
 * `forceCollectOnWake`. Every background drain beside it IS gated (the forced
 * `collect_results` tool is their single consumer), so the interjection drain
 * looks like an oversight and invites a tidy-up. It is not one — a user message
 * has no tool consumer, and routing it through a tool result would swallow the
 * user's own words on exactly the turns that already have something to report.
 * Driving a real wake turn needs the renderer's `continueAfterQuestions` +
 * `systemWake` dispatch, which this harness cannot produce (`park-resume` hits
 * the same wall and drives resumes as ordinary turns). The comment at the drain
 * site carries the reason; this note says why no test does.
 *
 * THE MID-TURN WINDOW IS A PERMISSION BLOCK, not a sleep. The scripted model
 * calls edit_file with auto-approve off, so the stream BLOCKS in
 * waitForApproval — a window with no timing assumption in it. The message is
 * recorded there, then the approval is granted, and the next step's request is
 * the one under test.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";
import {
  recordUserInterjection,
  clearUserInterjections,
  hasPendingUserInterjections,
} from "@/lib/agent/user-interjections";

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

type RecordedRequest = {
  messages: Array<{ role: string; content?: unknown }>;
};

const userContents = (req: RecordedRequest): string[] =>
  (req.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );

describe("mid-turn user messages", () => {
  it("delivers a message typed mid-turn into the SAME turn, untagged", async () => {
    ctx.server.register(
      scenario("interject-midturn")
        .toolCall("edit_file", {
          operation: "write",
          path: "src/answer.ts",
          content: "export const answer = 42;\n",
          description: "Answer module",
        })
        .text("Created it, and switched to Postgres as you asked.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    clearUserInterjections(chatId);

    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=interject-midturn Create an answer module.",
      mode: "build",
      during: async (ipc) => {
        // The turn is now BLOCKED on the permission card — a real mid-turn
        // moment, with no sleep involved.
        const permission = await ipc.waitFor(
          "permission-request",
          (p) => p?.chatId === chatId,
        );
        recordUserInterjection(chatId, {
          id: "ij-1",
          text: "actually use Postgres",
        });
        const executePermission = await getIpcHandler("execute-permission");
        await executePermission({} as never, {
          chatId,
          operationId: permission.payload.operationId,
        });
      },
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor(
      "interject-midturn",
    ) as RecordedRequest[];
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const post = requests[requests.length - 1]!;
    const users = userContents(post);

    // The message is there…
    const mine = users.find((c) => c.includes("actually use Postgres"));
    expect(mine, "the mid-turn message must reach the model").toBeTruthy();
    // …as its OWN message, carrying nothing but the user's words.
    expect(mine).toBe("actually use Postgres");
    // …and NOT wrapped as a harness nudge.
    expect(mine).not.toContain("system-reminder");

    // The queue is drained, so the stream-end fallback cannot re-send it as a
    // fresh turn. "Delivered mid-turn OR opens the next turn, never both."
    expect(hasPendingUserInterjections(chatId)).toBe(false);

    // The harness note about it rides the TAGGED block, not the user's message.
    const tagged = users.filter((c) => c.includes("<system-reminder>"));
    expect(
      tagged.some((c) => c.includes("while you were working")),
      "the harness explains the untagged message inside the tagged block",
    ).toBe(true);
  });

  it("keeps several messages in the order they were typed", async () => {
    ctx.server.register(
      scenario("interject-order")
        .toolCall("edit_file", {
          operation: "write",
          path: "src/two.ts",
          content: "export const two = 2;\n",
          description: "Two",
        })
        .text("Done — using SQLite.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    clearUserInterjections(chatId);

    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=interject-order Create a module.",
      mode: "build",
      during: async (ipc) => {
        const permission = await ipc.waitFor(
          "permission-request",
          (p) => p?.chatId === chatId,
        );
        recordUserInterjection(chatId, { id: "a", text: "use Postgres" });
        recordUserInterjection(chatId, { id: "b", text: "no wait, SQLite" });
        const executePermission = await getIpcHandler("execute-permission");
        await executePermission({} as never, {
          chatId,
          operationId: permission.payload.operationId,
        });
      },
    });

    expectNoStreamError(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor(
      "interject-order",
    ) as RecordedRequest[];
    const users = userContents(requests[requests.length - 1]!);
    const first = users.indexOf("use Postgres");
    const second = users.indexOf("no wait, SQLite");
    expect(first, "first message present").toBeGreaterThanOrEqual(0);
    expect(second, "second message present").toBeGreaterThanOrEqual(0);
    // A correction only means anything if it reads AFTER what it corrects.
    expect(second).toBeGreaterThan(first);
  });

});
