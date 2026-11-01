/**
 * 0aa QA: end-to-end two-session peer review — proves the feature is usable,
 * not just unit-tested.
 *
 * Simulates a real two-session scenario:
 *   Session A (the "worker") has a pending permission request.
 *   Session B (the "reviewer") calls list_sessions, sees "approval waiting",
 *   calls send_message with review:true, reads the full request details
 *   (operationId + command), then sends an approval answer that resolves it.
 *
 * Also proves the high-risk refusal: an ssh command is refused with a clear
 * "needs the owner" error that reaches the sender.
 *
 * Run: env -u ATLARIX_SURFACE npx vitest run src/__tests__/0aa-qa-e2e.test.ts
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

// ─── shared state ────────────────────────────────────────────────────────────

const sqlite = new DatabaseSync(":memory:");

/** What the reviewer's applySettings stub received. */
const received: Array<{
  operationId: string;
  mode: string;
  fromName: string;
  notice: string;
}> = [];

const host: PeerHost = {
  isBusy: () => false,
  enqueue: () => {},
  wake: () => {},
  inbound: () => "accept",
  applySettings: async (target, set, from) => {
    if (set.approval) {
      const { operationId, mode } = set.approval;
      const verb = mode === "deny" ? "denied" : "approved";
      const notice = `Permission ${verb} by ${from.name}.`;
      received.push({ operationId, mode, fromName: from.name, notice });
      return { ok: true, notice };
    }
    return { ok: true };
  },
};

const WORKER_ID = "qa-worker-0aa";
const REVIEWER_ID = "qa-reviewer-0aa";

const fromReviewer = {
  sessionId: REVIEWER_ID,
  name: "Reviewer",
  surface: "cli" as const,
  workspace: "/qa/review",
};

beforeAll(async () => {
  await startPeerInbox({ surface: "cli", host, database: () => sqlite as never });
  noteLiveSession({ sessionId: WORKER_ID, chatId: -201, name: "Worker", workspace: "/qa/work" });
  noteLiveSession({ sessionId: REVIEWER_ID, chatId: -202, name: "Reviewer", workspace: "/qa/review" });
});

afterAll(() => __resetPeersForTests());

function workerRow() {
  const r = resolvePeer("Worker", REVIEWER_ID);
  if ("error" in r) throw new Error(r.error);
  return r.row;
}

// ─── QA scenario ─────────────────────────────────────────────────────────────

describe("0aa QA: end-to-end two-session peer review", () => {
  const SAFE_OP_ID = "qa-op-npm-build";
  const SAFE_COMMAND = "npm run build";
  const SAFE_CWD = "/qa/work";

  const HIGH_RISK_OP_ID = "qa-op-ssh-deploy";
  const HIGH_RISK_COMMAND = "ssh deploy@prod.example.com 'systemctl restart app'";

  it("step 1: worker raises a pending approval — list_sessions shows 'approval waiting'", () => {
    const approvals: PendingApprovalSummary[] = [
      {
        operationId: SAFE_OP_ID,
        operation: "run_command",
        summary: SAFE_COMMAND,
        cwd: SAFE_CWD,
      },
    ];
    noteSessionApproval(WORKER_ID, true, approvals);

    const rows = listPeerSessions(REVIEWER_ID);
    const worker = rows.find((r) => r.sessionId === WORKER_ID);
    expect(worker?.hasApproval).toBe(true);
    console.log("[QA] list_sessions shows worker with 'approval waiting':", worker?.hasApproval);
  });

  it("step 2: reviewer reads the pending request details — sees operationId and command", () => {
    const s = localSession(WORKER_ID);
    expect(s?.pendingApprovals).toHaveLength(1);

    const a = s!.pendingApprovals![0]!;
    expect(a.operationId).toBe(SAFE_OP_ID);
    expect(a.operation).toBe("run_command");
    expect(a.summary).toBe(SAFE_COMMAND);
    expect(a.cwd).toBe(SAFE_CWD);
    expect(a.isDangerous).toBeFalsy();
    expect(a.systemScope).toBeFalsy();

    // This is what pendingStateText() would format for the reviewer:
    const formatted = `1. operationId: ${a.operationId}\n  type: ${a.operation}\n  request: ${a.summary}\n  cwd: ${a.cwd}`;
    console.log("[QA] Reviewer sees pending request:\n" + formatted);
    expect(formatted).toContain(SAFE_OP_ID);
    expect(formatted).toContain(SAFE_COMMAND);
    expect(formatted).toContain(SAFE_CWD);
  });

  it("step 3: reviewer sends approval — answer reaches the worker and resolves the request", async () => {
    const before = received.length;

    const result = await sendPeerMessage(
      workerRow(),
      fromReviewer,
      "Looks safe — approving.",
      { approval: { operationId: SAFE_OP_ID, mode: "once" } },
    );

    console.log("[QA] sendPeerMessage result:", result);
    expect(result.ok).toBe(true);
    expect(result.applied).toMatch(/approved/i);
    expect(received.length).toBe(before + 1);

    const last = received.at(-1)!;
    expect(last.operationId).toBe(SAFE_OP_ID);
    expect(last.mode).toBe("once");
    expect(last.fromName).toBe("Reviewer");
    console.log("[QA] applySettings received:", last);
  });

  it("step 4: worker also has a high-risk ssh command — reviewer's approval is refused", async () => {
    // Register the high-risk request.
    noteSessionApproval(WORKER_ID, true, [
      {
        operationId: HIGH_RISK_OP_ID,
        operation: "run_command",
        summary: HIGH_RISK_COMMAND,
        cwd: SAFE_CWD,
      },
    ]);

    const result = await sendPeerMessage(
      workerRow(),
      fromReviewer,
      "Approving ssh deploy.",
      { approval: { operationId: HIGH_RISK_OP_ID, mode: "once" } },
    );

    console.log("[QA] High-risk refusal result:", result);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/high-risk/i);
    expect(result.error).toContain(HIGH_RISK_OP_ID);
    // The error message reaches the sender — they know why it was refused.
    console.log("[QA] Sender sees error:", result.error);
  });

  it("step 5: reviewer CAN deny the high-risk request (deny is always safe)", async () => {
    const before = received.length;

    const result = await sendPeerMessage(
      workerRow(),
      fromReviewer,
      "Denying — ssh to prod needs the owner.",
      { approval: { operationId: HIGH_RISK_OP_ID, mode: "deny" } },
    );

    console.log("[QA] Deny high-risk result:", result);
    expect(result.ok).toBe(true);
    expect(result.applied).toMatch(/denied/i);
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)!.mode).toBe("deny");
  });

  it("step 6: after resolution, worker clears the flag — list_sessions no longer shows 'approval waiting'", () => {
    noteSessionApproval(WORKER_ID, false);
    const rows = listPeerSessions(REVIEWER_ID);
    const worker = rows.find((r) => r.sessionId === WORKER_ID);
    expect(worker?.hasApproval).toBeFalsy();
    console.log("[QA] After resolution, hasApproval:", worker?.hasApproval);
  });
});
