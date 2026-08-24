import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { db } from "@/db";
import { editStats } from "@/db/schema";

/**
 * Edit stats, through the REAL write path.
 *
 * Asserted here rather than against the tool's result envelope on purpose. The
 * standing lesson from the outside-workspace-write work is that proving a tool
 * returned the right `__permission_required` shape proves nothing about what
 * executed — and this feature lives entirely in `executeOperation`, several frames
 * below the tool. So the test drives an approval the way the renderer does and then
 * reads the database.
 *
 * It also pins the ROLLUP contract: a second edit by the same model on the same day
 * must accumulate into the row already there, not open a new one.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function statsRows() {
  return db.select().from(editStats);
}

/** Drive one scripted write to completion, playing the renderer's approval. */
async function runApprovedWrite(
  scenarioId: string,
  file: string,
  content: string,
): Promise<void> {
  ctx.server.register(
    scenario(scenarioId)
      .toolCall("edit_file", {
        operation: "write",
        path: file,
        content,
        description: `write ${file}`,
      })
      .text(`Wrote ${file}.`)
      .repeatLast()
      .build(),
  );
  const chatId = await ctx.newChat();
  await runTurn(ctx, {
    chatId,
    prompt: `sc=${scenarioId} write ${file}`,
    mode: "build",
    during: async (ipc) => {
      const permission = await ipc.waitFor(
        "permission-request",
        (p) => p?.chatId === chatId,
      );
      const executePermission = await getIpcHandler("execute-permission");
      const result: any = await executePermission({} as any, {
        chatId,
        operationId: permission.payload.operationId,
      });
      expect(result.approved).toBe(true);
    },
  });
}

describe("edit stats land when a write is approved", () => {
  it("records the lines, the workspace and the model", async () => {
    await runApprovedWrite("stats-first", "src/one.ts", "a\nb\nc\n");

    const rows = await statsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(ctx.appId);
    expect(rows[0].linesAdded).toBe(3);
    expect(rows[0].linesRemoved).toBe(0);
    expect(rows[0].edits).toBe(1);
    // Attributed to the model that ran the turn, not to the provider generically.
    expect(rows[0].provider).toBe(ctx.providerId);
    expect(rows[0].modelId).toBe(ctx.modelName);
    // Local calendar day, so "today" means the user's today.
    expect(rows[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 40_000);

  it("accumulates into the same daily bucket rather than adding a row", async () => {
    await runApprovedWrite("stats-second", "src/two.ts", "one\ntwo\n");

    const rows = await statsRows();
    // Still ONE row: same workspace, same day, same model.
    expect(rows).toHaveLength(1);
    expect(rows[0].linesAdded).toBe(5); // 3 + 2
    expect(rows[0].edits).toBe(2);
  }, 40_000);
});
