/**
 * Reopening a workspace must land on a FRESH Untitled, not on the newest session.
 *
 * The bug (reported 2026-09-06): `resolveSessionAndChat` resumed
 * `sessions[0]` sorted by `updatedAt` desc. `sessions:list` returns that same
 * order, so the resumed session was ALWAYS the top row — and
 * `WorkspaceSessionList`'s row handler early-returned when the clicked row was
 * already active. The top session was therefore unopenable: you had to click a
 * different row and come back.
 *
 * WHY THIS IS A SOURCE-TEXT TEST, and not a behavioural one. `resolveSessionAndChat`
 * is module-private, and there is no established `vi.mock("@/ipc/ipc_client")`
 * pattern in this repo — standing one up for a single guard would be more
 * machinery than the thing it guards. The repo already uses source-text guards for
 * exactly this shape of "a future edit reintroduces the pattern" risk
 * (`settings-nav-parity`, `preload-invoke-channels`), so this follows them.
 *
 * What it protects is a DECISION, not an implementation detail: reopen goes
 * through `startWorkspaceConversation`, whose handler reuses a most-recent empty
 * default-titled session and prunes other stale empties (`pickSessionReuse`, and
 * see `session-reuse.test.ts`). That is why landing on a fresh session does not
 * stack Untitled rows. The CLI path always did this; the renderer used to diverge.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.join(__dirname, "..");

function resolveSessionAndChatBody(): string {
  const source = fs.readFileSync(
    path.join(SRC, "lib/open-workspace-session.ts"),
    "utf8",
  );
  const start = source.indexOf("async function resolveSessionAndChat(");
  expect(
    start,
    "resolveSessionAndChat was renamed or removed — re-point this guard rather than deleting it",
  ).toBeGreaterThan(-1);
  // The next top-level `export` after it bounds the body; the function is the
  // last thing before `export type OpenWorkspaceByAppIdOptions`.
  const end = source.indexOf("\nexport ", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("reopening a workspace lands on a fresh session", () => {
  it("resolves through startWorkspaceConversation", () => {
    expect(resolveSessionAndChatBody()).toContain("startWorkspaceConversation");
  });

  it("does NOT list sessions to pick the newest one", () => {
    const body = resolveSessionAndChatBody();
    // Either call reintroduces the bug: listing is how it found the newest
    // session, and allocateSessionTransport is how it attached to it.
    expect(
      body,
      "reopen must not enumerate sessions to resume the newest — that is the bug this guards",
    ).not.toContain("listWorkspaceSessions");
    expect(body).not.toContain("allocateSessionTransport");
  });

  it("does not sort by updatedAt", () => {
    expect(resolveSessionAndChatBody()).not.toContain("updatedAt");
  });

  it("keeps the already-active row clickable rather than a no-op", () => {
    const source = fs.readFileSync(
      path.join(SRC, "components/workspace/WorkspaceSessionList.tsx"),
      "utf8",
    );
    // A bare `if (activeSessionId === session.id) return;` is the no-op that made
    // the selected row feel broken. The guard must still exist (falling through
    // re-hydrates a session already loaded) but must DO something first.
    const bareNoOp = /if \(activeSessionId === session\.id\) return;/;
    expect(
      bareNoOp.test(source),
      "the active row must re-focus, not return silently",
    ).toBe(false);
    expect(source).toContain("if (activeSessionId === session.id) {");
  });
});
