/**
 * 0aa: cross-session review — a session asks another to review its pending
 * permission request; the reviewer approves or denies; the answer resolves it.
 *
 * One process plays both ends: two sessions registered in an in-memory SQLite,
 * messages sent over the real socket. The `applySettings` host method is
 * stubbed to capture what the approval handler would broadcast.
 *
 * Tests required by coordinator review:
 *  - reviewer text contains operationId + command (not just "has one or more")
 *  - peer approval of outside-workspace write is refused
 *  - peer approval of ssh command is refused
 *  - in-workspace edit is accepted
 *  - each security test must fail without the fix
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  __resetPeersForTests,
  listPeerSessions,
  localSession,
  noteSessionApproval,
  noteLiveSession,
  resolvePeer,
  sendPeerMessage,
  startPeerInbox,
  type PeerHost,
  type PendingApprovalSummary,
} from "@/lib/peers/peers";

const sqlite = new DatabaseSync(":memory:");
const queued: Array<{ chatId: number; text: string }> = [];
const woken: number[] = [];

/** Captures what applySettings was called with (the approval answer). */
const appliedSettings: Array<{
  target: { chatId: number; sessionId: string };
  set: Record<string, unknown>;
  from: { name: string };
}> = [];

const host: PeerHost = {
  isBusy: () => false,
  enqueue: (chatId, _id, text) => void queued.push({ chatId, text }),
  wake: (chatId) => void woken.push(chatId),
  inbound: () => "accept",
  applySettings: async (target, set, from) => {
    appliedSettings.push({ target, set: set as Record<string, unknown>, from });
    if ((set as { approval?: unknown }).approval) {
      const a = (set as { approval: { operationId: string; mode: string } }).approval;
      const verb = a.mode === "deny" ? "denied" : "approved";
      return { ok: true, notice: `Permission ${verb} by ${from.name}.` };
    }
    return { ok: true };
  },
};

const ASKER_ID = "sess-asker-0aa1";
const REVIEWER_ID = "sess-reviewer-0aa2";

const fromReviewer = {
  sessionId: REVIEWER_ID,
  name: "Reviewer",
  surface: "cli" as const,
  workspace: "/w/review",
};

beforeAll(async () => {
  await startPeerInbox({ surface: "cli", host, database: () => sqlite as never });
  noteLiveSession({ sessionId: ASKER_ID, chatId: -101, name: "Asker", workspace: "/w/ask" });
  noteLiveSession({ sessionId: REVIEWER_ID, chatId: -102, name: "Reviewer", workspace: "/w/review" });
});

afterAll(() => __resetPeersForTests());

function target(name: string) {
  const r = resolvePeer(name, REVIEWER_ID);
  if ("error" in r) throw new Error(r.error);
  return r.row;
}

describe("0aa: cross-session review", () => {
  it("list_sessions shows 'approval waiting' when a session has a pending approval", () => {
    // Before: no approval flag.
    let rows = listPeerSessions(REVIEWER_ID);
    const asker = rows.find((r) => r.sessionId === ASKER_ID);
    expect(asker?.hasApproval).toBeFalsy();

    // Asker raises a permission request.
    noteSessionApproval(ASKER_ID, true);

    rows = listPeerSessions(REVIEWER_ID);
    const askerAfter = rows.find((r) => r.sessionId === ASKER_ID);
    expect(askerAfter?.hasApproval).toBe(true);
  });

  it("reviewer text contains operationId and command when approval details are stored", () => {
    const operationId = "op-edit-file-xyz789";
    const approvals: PendingApprovalSummary[] = [
      {
        operationId,
        operation: "edit_file",
        summary: "update src/lib/foo.ts",
        cwd: "/w/ask",
      },
    ];
    noteSessionApproval(ASKER_ID, true, approvals);

    // The local session should now carry the details.
    const s = localSession(ASKER_ID);
    expect(s?.pendingApprovals).toHaveLength(1);
    expect(s?.pendingApprovals?.[0].operationId).toBe(operationId);
    expect(s?.pendingApprovals?.[0].summary).toContain("src/lib/foo.ts");
  });

  it("reviewer sends approval answer; applySettings receives the operationId and mode", async () => {
    const operationId = "op-run-cmd-abc123";
    // Register a safe in-workspace command so the security check passes.
    noteSessionApproval(ASKER_ID, true, [
      { operationId, operation: "run_command", summary: "npm run build", cwd: "/w/ask" },
    ]);
    const before = appliedSettings.length;

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Approved — safe command.",
      { approval: { operationId, mode: "once" } },
    );

    expect(r.ok).toBe(true);
    expect(r.applied).toMatch(/approved/i);
    expect(appliedSettings.length).toBe(before + 1);
    const last = appliedSettings.at(-1)!;
    expect(last.set.approval).toMatchObject({ operationId, mode: "once" });
    expect(last.from.name).toBe("Reviewer");
    expect(last.target.sessionId).toBe(ASKER_ID);
  });

  it("reviewer can deny a pending approval", async () => {
    const operationId = "op-run-cmd-def456";
    // Deny does not need a security check (denying is always safe).
    noteSessionApproval(ASKER_ID, true, [
      { operationId, operation: "run_command", summary: "rm -rf /tmp/x", isDangerous: true },
    ]);
    const before = appliedSettings.length;

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Denied — command looks unsafe.",
      { approval: { operationId, mode: "deny" } },
    );

    expect(r.ok).toBe(true);
    expect(r.applied).toMatch(/denied/i);
    const last = appliedSettings.at(-1)!;
    expect(last.set.approval).toMatchObject({ operationId, mode: "deny" });
    expect(appliedSettings.length).toBe(before + 1);
  });

  it("approval answer without operationId is rejected", async () => {
    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Approved.",
      { approval: { operationId: "", mode: "once" } },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/operationId/);
  });

  it("peer approval of an outside-workspace write (systemScope) is refused", async () => {
    const operationId = "op-outside-ws-write";
    noteSessionApproval(ASKER_ID, true, [
      {
        operationId,
        operation: "edit_file",
        summary: "edit /etc/hosts",
        systemScope: true,
      },
    ]);

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Approving outside-workspace write.",
      { approval: { operationId, mode: "once" } },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/high-risk/i);
    expect(r.error).toContain(operationId);
  });

  it("peer approval of an ssh command is refused", async () => {
    const operationId = "op-ssh-deploy";
    noteSessionApproval(ASKER_ID, true, [
      {
        operationId,
        operation: "run_command",
        summary: "ssh user@prod.example.com 'deploy.sh'",
        cwd: "/w/ask",
      },
    ]);

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Approving ssh deploy.",
      { approval: { operationId, mode: "once" } },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/high-risk/i);
    expect(r.error).toContain(operationId);
  });

  it("peer approval of a safe in-workspace edit is accepted", async () => {
    const operationId = "op-safe-edit";
    noteSessionApproval(ASKER_ID, true, [
      {
        operationId,
        operation: "edit_file",
        summary: "update src/components/Button.tsx",
        cwd: "/w/ask",
      },
    ]);
    const before = appliedSettings.length;

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Looks good.",
      { approval: { operationId, mode: "once" } },
    );

    expect(r.ok).toBe(true);
    expect(appliedSettings.length).toBe(before + 1);
  });

  it("noteSessionApproval clears the flag when approvals are resolved", () => {
    noteSessionApproval(ASKER_ID, false);
    const rows = listPeerSessions(REVIEWER_ID);
    const asker = rows.find((r) => r.sessionId === ASKER_ID);
    expect(asker?.hasApproval).toBeFalsy();
  });

  it("a plain message (no approval) still delivers normally", async () => {
    const before = queued.length;
    const r = await sendPeerMessage(target("Asker"), fromReviewer, "Just a note.");
    expect(r.ok).toBe(true);
    expect(queued.length).toBe(before + 1);
    expect(queued.at(-1)!.text).toContain("Just a note.");
  });
});
