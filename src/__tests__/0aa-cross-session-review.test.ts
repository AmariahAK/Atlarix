/**
 * 0aa: cross-session review — a session asks another to review its pending
 * permission request; the reviewer approves or denies; the answer resolves it.
 *
 * One process plays both ends: two sessions registered in an in-memory SQLite,
 * messages sent over the real socket. The `applySettings` host method is
 * stubbed to capture what the approval handler would broadcast.
 *
 * High-risk guard uses dynamic signals only (isDangerous, systemScope,
 * sandbox_escalation) — no static command regex (owner verdict 2026-11-01).
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
    let rows = listPeerSessions(REVIEWER_ID);
    const asker = rows.find((r) => r.sessionId === ASKER_ID);
    expect(asker?.hasApproval).toBeFalsy();

    noteSessionApproval(ASKER_ID, true);

    rows = listPeerSessions(REVIEWER_ID);
    const askerAfter = rows.find((r) => r.sessionId === ASKER_ID);
    expect(askerAfter?.hasApproval).toBe(true);
  });

  it("a session in ANOTHER process: its pending requests, with the diff, reach this one through the registry", async () => {
    const os = await import("node:os");
    const { LIVE_SESSIONS_TABLE } = await import("@/lib/peers/peers");
    const pending: PendingApprovalSummary[] = [
      { operationId: "op-remote-1", operation: "edit_file", summary: "update src/pay.ts", detail: "@@ -1 +1 @@\n-a\n+b" },
    ];
    // What that process's publish() writes: this one has no memory of it.
    sqlite
      .prepare(
        `INSERT INTO ${LIVE_SESSIONS_TABLE}
         (session_id, pid, host, socket, token, name, workspace, surface, busy, last_seen, aliases, model, last_turn, has_approval, pending_approvals)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // A live process that is not this one: the registry drops rows of dead ones.
      .run("sess-remote-app-0aa9", process.ppid, os.hostname(), "/tmp/none.sock", "t", "App chat", "/w/app", "app", 1, Date.now(), "[]", "", "", 1, JSON.stringify(pending));
    const row = listPeerSessions(REVIEWER_ID).find((r) => r.sessionId === "sess-remote-app-0aa9");
    expect(row?.hasApproval).toBe(true);
    expect(row?.pendingApprovals).toEqual(pending);

    const { ToolRegistry } = await import("@/lib/tools");
    let raw = (await ToolRegistry.execute("list_sessions", { workspaceSessionId: REVIEWER_ID, pending_of: "App chat" })) as unknown;
    while (raw && typeof raw === "object" && "result" in raw) raw = (raw as { result: unknown }).result;
    const text = String((raw as { text?: string }).text);
    expect(text).toContain("op-remote-1");
    expect(text).toContain("update src/pay.ts");
    expect(text).toContain("+b");
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

    const s = localSession(ASKER_ID);
    expect(s?.pendingApprovals).toHaveLength(1);
    expect(s?.pendingApprovals?.[0].operationId).toBe(operationId);
    expect(s?.pendingApprovals?.[0].summary).toContain("src/lib/foo.ts");
  });

  it("reviewer sends approval answer; applySettings receives the operationId and mode", async () => {
    const operationId = "op-run-cmd-abc123";
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

  it("deny is always allowed even when isDangerous is set", async () => {
    const operationId = "op-deny-dangerous";
    noteSessionApproval(ASKER_ID, true, [
      { operationId, operation: "run_command", summary: "some risky op", isDangerous: true },
    ]);
    const before = appliedSettings.length;

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Denied — looks unsafe.",
      { approval: { operationId, mode: "deny" } },
    );

    expect(r.ok).toBe(true);
    expect(r.applied).toMatch(/denied/i);
    expect(appliedSettings.at(-1)!.set.approval).toMatchObject({ operationId, mode: "deny" });
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

  it("peer approval refused when isDangerous flag is set (dynamic signal)", async () => {
    const operationId = "op-is-dangerous";
    noteSessionApproval(ASKER_ID, true, [
      { operationId, operation: "run_command", summary: "anything", isDangerous: true },
    ]);

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Approving.",
      { approval: { operationId, mode: "once" } },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/high-risk/i);
    expect(r.error).toContain(operationId);
  });

  it("peer approval refused when systemScope flag is set (dynamic signal)", async () => {
    const operationId = "op-system-scope";
    noteSessionApproval(ASKER_ID, true, [
      { operationId, operation: "edit_file", summary: "edit /etc/hosts", systemScope: true },
    ]);

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Approving.",
      { approval: { operationId, mode: "once" } },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/high-risk/i);
    expect(r.error).toContain(operationId);
  });

  it("peer approval refused for sandbox_escalation operation (dynamic signal)", async () => {
    const operationId = "op-sandbox-esc";
    noteSessionApproval(ASKER_ID, true, [
      { operationId, operation: "sandbox_escalation", summary: "grant /secrets" },
    ]);

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Approving.",
      { approval: { operationId, mode: "once" } },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/high-risk/i);
    expect(r.error).toContain(operationId);
  });

  it("peer approval accepted for safe in-workspace edit (no risk flags)", async () => {
    const operationId = "op-safe-edit";
    noteSessionApproval(ASKER_ID, true, [
      { operationId, operation: "edit_file", summary: "update src/components/Button.tsx", cwd: "/w/ask" },
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

  it("peer approval accepted for ssh command with no risk flags set (gate decides, not peer)", async () => {
    // Without isDangerous/systemScope the peer layer does NOT block it —
    // the gate that raised the request is responsible for setting those flags.
    const operationId = "op-ssh-no-flags";
    noteSessionApproval(ASKER_ID, true, [
      { operationId, operation: "run_command", summary: "ssh user@host", cwd: "/w/ask" },
    ]);
    const before = appliedSettings.length;

    const r = await sendPeerMessage(
      target("Asker"),
      fromReviewer,
      "Approved.",
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
