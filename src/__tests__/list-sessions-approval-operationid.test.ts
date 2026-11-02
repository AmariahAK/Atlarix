/**
 * Bug 11 regression: list_sessions must include operationId(s) in the session
 * line when a session has pending approval requests, so a supervising session
 * can call send_message({approval: operationId}) without a separate review:true
 * round-trip.
 *
 * Tests the approvalWaitingText helper (the formatting layer).
 * The data-layer propagation (listPeerSessions pendingApprovals) is tested in
 * peer-messaging.test.ts where the SQLite peer registry is already set up.
 */
import { describe, it, expect } from "vitest";
import { approvalWaitingText } from "@/lib/tools/peers";

describe("approvalWaitingText (Bug 11)", () => {
  it("returns a plain flag when no pendingApprovals detail is available (older CLI)", () => {
    const text = approvalWaitingText({});
    expect(text).toBe(" · approval waiting");
  });

  it("includes the operationId and operation type for a single approval", () => {
    const text = approvalWaitingText({
      pendingApprovals: [{ operationId: "op-abc123", operation: "run_command" }],
    });
    expect(text).toContain("op-abc123");
    expect(text).toContain("run_command");
    expect(text).toContain("operationId:");
  });

  it("includes all operationIds for multiple pending approvals", () => {
    const text = approvalWaitingText({
      pendingApprovals: [
        { operationId: "op-111", operation: "edit_file" },
        { operationId: "op-222", operation: "run_command" },
      ],
    });
    expect(text).toContain("op-111");
    expect(text).toContain("op-222");
    expect(text).toContain("edit_file");
    expect(text).toContain("run_command");
  });

  it("omits the operation type when not present", () => {
    const text = approvalWaitingText({
      pendingApprovals: [{ operationId: "op-xyz" }],
    });
    expect(text).toContain("op-xyz");
    // No trailing "(undefined)" or similar
    expect(text).not.toContain("undefined");
  });
});
