import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v12 0.3 — the edit-verify loop (postWriteVerify seam, wired end-to-end).
 *
 * After a round that wrote files, the engine runs LSP diagnostics on the
 * round's writes and feeds ERRORS back as a user message — and a same-round
 * <task_complete> on broken code is BLOCKED (bounded) so the model fixes
 * before finishing. Gated on `enableAutoFixProblems` (1.2 — the toggle
 * finally has logic).
 *
 * The language server is mocked (spawning real LSP binaries is not viable in
 * the harness): the ENGINE wiring, write side-channel delta, gate, and
 * message-injection paths under test are all real.
 */

vi.mock("@/lib/lsp/lsp-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/lsp/lsp-client")>();
  return {
    ...original,
    requestLspDiagnosticsAfterSync: vi.fn(async (filePath: string) =>
      filePath.endsWith("bad.ts")
        ? [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 12 },
              },
              message: "Cannot find name 'nope'.",
              severity: 1,
            },
          ]
        : [],
    ),
  };
});

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const approveFirstPermission =
  (chatId: number) => async (ipc: { waitFor: Function }) => {
    const permission: any = await (ipc.waitFor as any)(
      "permission-request",
      (p: any) => p?.chatId === chatId,
    );
    const executePermission = await getIpcHandler("execute-permission");
    await executePermission({} as any, {
      chatId,
      operationId: permission.payload.operationId,
    });
  };

describe("edit-verify loop (0.3)", () => {
  it("blocks a same-round task_complete on broken code and feeds diagnostics back", async () => {
    ctx.server.register(
      scenario("verify-block")
        // Round 1: write a file the mocked LSP flags, then claim done.
        .toolCall("write_file", {
          path: "src/bad.ts",
          content: "export const x = nope;\n",
          description: "Broken module",
        })
        .text("Wrote the module. <task_complete>")
        // Round 2 (exists only because the engine blocked the break): the
        // model acknowledges the diagnostics and finishes (no new writes →
        // verify passes → the break is honored).
        .text("Acknowledged the errors — fixed. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=verify-block Create the module.",
      mode: "build",
      during: approveFirstPermission(chatId),
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // The diagnostics feedback reached the model: a recorded request carries
    // the <diagnostics> block as a user message (round 2's dispatch).
    const requests = ctx.server.requestsFor("verify-block") as Array<{
      messages: Array<{ role: string; content?: unknown }>;
    }>;
    const withDiagnostics = requests.filter((r) =>
      r.messages.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes('<diagnostics file="src/bad.ts">') &&
          m.content.includes("Cannot find name 'nope'."),
      ),
    );
    expect(
      withDiagnostics.length,
      "diagnostics feedback must reach the model after the blocked task_complete",
    ).toBeGreaterThanOrEqual(1);

    // B2 purity: the verify feedback is transient round input — never in the
    // persisted native-history envelope.
    const endPayload = fakeIpc
      .sentOn("chat:response:end")
      .map((s) => s.payload)
      .find((p) => p?.assistantModelContent);
    if (endPayload?.assistantModelContent) {
      expect(endPayload.assistantModelContent).not.toContain("<diagnostics");
    }
  }, 30_000);

  it("does not inject diagnostics when enableAutoFixProblems is off (1.2 gate)", async () => {
    ctx.server.register(
      scenario("verify-gated")
        .toolCall("write_file", {
          path: "src/also-bad.ts",
          content: "export const y = nope;\n",
          description: "Broken module (gate off)",
        })
        .text("Wrote it. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=verify-gated Create the module.",
      mode: "build",
      settings: { enableAutoFixProblems: false },
      during: approveFirstPermission(chatId),
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // Toggle honored: no diagnostics block anywhere, turn ended on round 1.
    const requests = ctx.server.requestsFor("verify-gated") as Array<unknown>;
    expect(JSON.stringify(requests)).not.toContain("<diagnostics");
  }, 30_000);

  it("edit_file no-match returns structured retry guidance", async () => {
    // The near-miss heuristic keys on the first 30 chars of old_content —
    // the stale part must come AFTER that prefix for the candidate to hit.
    ctx.ws.write(
      "src/target.ts",
      "export const realAnswerValue = computeAnswer(1);\n",
    );
    ctx.server.register(
      scenario("nomatch-guidance")
        .toolCall("edit_file", {
          path: "src/target.ts",
          operation: "replace",
          old_content: "export const realAnswerValue = computeAnswer(999);",
          new_content: "export const realAnswerValue = computeAnswer(2);",
          description: "Edit with stale content",
        })
        .text("I see — re-reading. <task_complete>")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=nomatch-guidance Update the constant.",
      mode: "build",
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // The tool result the model saw includes the near-miss region + explicit
    // re-read-and-retry guidance (not just a bare error).
    const blob = JSON.stringify(ctx.server.requestsFor("nomatch-guidance"));
    expect(blob).toContain("Closest candidate at line");
    expect(blob).toContain("retry with the EXACT current content");
  }, 30_000);
});
