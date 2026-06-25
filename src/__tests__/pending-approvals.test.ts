import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addPendingApproval,
  hasPendingApprovals,
  resolvePendingApproval,
  takePendingApprovalResults,
  hasPendingApprovalResults,
  clearPendingApprovalsForChat,
  setApprovalNotifier,
} from "@/lib/agent/pending-approvals";

describe("pending-approvals (Item 5 grace-then-park)", () => {
  afterEach(() => {
    clearPendingApprovalsForChat(7001);
    clearPendingApprovalsForChat(7002);
    setApprovalNotifier(() => {});
  });

  it("registers a pending approval, resolves it, drains take-once", () => {
    const chatId = 7001;
    expect(hasPendingApprovals(chatId)).toBe(false);

    addPendingApproval(chatId, "op-1");
    expect(hasPendingApprovals(chatId)).toBe(true);
    expect(hasPendingApprovalResults(chatId)).toBe(false);

    resolvePendingApproval(chatId, "op-1", "approved", '{"success":true}');
    // moved from pending → resolved
    expect(hasPendingApprovals(chatId)).toBe(false);
    expect(hasPendingApprovalResults(chatId)).toBe(true);

    const block = takePendingApprovalResults(chatId);
    expect(block).toContain("[Approval results]");
    expect(block).toContain("approved");
    expect(block).toContain('{"success":true}');
    // take-once
    expect(takePendingApprovalResults(chatId)).toBeNull();
    expect(hasPendingApprovalResults(chatId)).toBe(false);
  });

  it("formats a rejection without leaking the result payload", () => {
    const chatId = 7001;
    addPendingApproval(chatId, "op-2");
    resolvePendingApproval(chatId, "op-2", "rejected", "(rejected by user)");
    const block = takePendingApprovalResults(chatId);
    expect(block).toContain("rejected");
    expect(block).toContain("Do not retry");
  });

  it("fires the notifier on resolve so a parked chat can auto-wake", () => {
    const chatId = 7001;
    const seen: number[] = [];
    setApprovalNotifier((cid) => seen.push(cid));
    addPendingApproval(chatId, "op-3");
    resolvePendingApproval(chatId, "op-3", "approved", "{}");
    expect(seen).toEqual([chatId]);
  });

  it("no-ops when resolving an op that never parked (decided inline)", () => {
    const chatId = 7001;
    const notify = vi.fn();
    setApprovalNotifier(notify);
    // never added → not pending
    resolvePendingApproval(chatId, "ghost", "approved", "{}");
    expect(notify).not.toHaveBeenCalled();
    expect(hasPendingApprovalResults(chatId)).toBe(false);
  });

  it("keeps approvals isolated per chat", () => {
    addPendingApproval(7001, "a");
    addPendingApproval(7002, "b");
    expect(hasPendingApprovals(7001)).toBe(true);
    expect(hasPendingApprovals(7002)).toBe(true);

    resolvePendingApproval(7001, "a", "approved", "{}");
    expect(hasPendingApprovals(7001)).toBe(false);
    expect(hasPendingApprovals(7002)).toBe(true);
    // 7002's result pool is untouched by 7001's drain
    expect(takePendingApprovalResults(7002)).toBeNull();
    expect(takePendingApprovalResults(7001)).toContain("[Approval results]");
  });

  it("clears all state for a chat", () => {
    addPendingApproval(7001, "x");
    resolvePendingApproval(7001, "x", "approved", "{}");
    clearPendingApprovalsForChat(7001);
    expect(hasPendingApprovals(7001)).toBe(false);
    expect(hasPendingApprovalResults(7001)).toBe(false);
  });
});
