/**
 * 15.11.0 (ai-c8, filming): stop a turn with an approval open and its bar
 * stayed: in every chat, with no Deny, until a restart. And its "Allow all
 * this turn" still reached the stopped turn's interceptor, which could apply
 * the stopped edit. Stop withdraws the turn's open cards.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sent: Array<{ channel: string; payload: { operationId?: string; status?: string } }> = [];
vi.mock("electron", async (orig) => ({
  ...(await orig<typeof import("electron")>()),
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: never) => sent.push({ channel, payload }) } }],
  },
}));

import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import {
  addOperation,
  getOperationsByStatus,
  withoutWaitingForChat,
  type QueuedOperation,
} from "@/atoms/permissionQueueAtom";

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-stop-cards-")));

describe("a stopped turn's open card", () => {
  it("is withdrawn: reported cancelled, and a late \"Allow all this turn\" runs nothing", async () => {
    const i = new PermissionInterceptor(ws);
    const id = i.generateOperationId();
    i.bufferOperation(
      id,
      { operation: "edit_file", preview: { path: path.join(ws, "ants.js"), content: "x\n", type: "create" } } as never,
      true,
    );
    i.endTurn();
    expect(sent.some((s) => s.channel === "operation-status" && s.payload.operationId === id && s.payload.status === "cancelled")).toBe(true);
    i.approveRestOfTurn();
    const ran = await i.executeAllOperations();
    expect(ran).toEqual([]);
    expect(fs.existsSync(path.join(ws, "ants.js"))).toBe(false);
  });
});

describe("the approvals bar's queue", () => {
  const op = (id: string, chatId: number): Omit<QueuedOperation, "timestamp"> => ({
    id,
    chatId,
    operation: "edit_file",
    path: "a.ts",
    status: "pending",
  });

  it("shows a chat only its own cards, and a stop takes them down", () => {
    let q = new Map<string, QueuedOperation>();
    q = addOperation(q, op("a", 1));
    q = addOperation(q, op("b", 2));
    expect(getOperationsByStatus(q, "pending", 1).map((o) => o.id)).toEqual(["a"]);
    expect(getOperationsByStatus(q, "pending", 2).map((o) => o.id)).toEqual(["b"]);
    q = withoutWaitingForChat(q, 1);
    expect(getOperationsByStatus(q, "pending", 1)).toEqual([]);
    expect(getOperationsByStatus(q, "pending", 2).map((o) => o.id)).toEqual(["b"]);
  });
});
