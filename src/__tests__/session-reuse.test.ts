/**
 * v10.1: app reopen / New chat reuses the newest empty default-titled session
 * and prunes stale empties — instead of stacking "Untitled" sessions.
 */

import { describe, expect, it } from "vitest";
import { pickSessionReuse } from "@/ipc/handlers/workspace_session_handlers";

const s = (id: string, title: string, messageCount: number) => ({
  id,
  title,
  messageCount,
});

describe("pickSessionReuse", () => {
  it("creates fresh when the workspace has no sessions", () => {
    expect(pickSessionReuse([])).toEqual({ reuseId: null, pruneIds: [] });
  });

  it("reuses the newest empty Untitled session", () => {
    const rows = [s("new-empty", "Untitled", 0), s("older", "Fix auth bug", 12)];
    expect(pickSessionReuse(rows)).toEqual({
      reuseId: "new-empty",
      pruneIds: [],
    });
  });

  it("never reuses or prunes sessions with messages", () => {
    const rows = [s("active", "Untitled", 3), s("named", "Refactor", 8)];
    expect(pickSessionReuse(rows)).toEqual({ reuseId: null, pruneIds: [] });
  });

  it("never touches custom-titled sessions even when empty", () => {
    const rows = [s("custom-empty", "My scratchpad", 0)];
    expect(pickSessionReuse(rows)).toEqual({ reuseId: null, pruneIds: [] });
  });

  it("prunes the stale empty backlog, keeping only the newest", () => {
    // 6 reopens in a day → 6 untitled empties; reuse 1, prune 5.
    const rows = [
      s("e6", "Untitled", 0),
      s("e5", "Untitled", 0),
      s("e4", "New session", 0),
      s("real", "Ship v10.1", 42),
      s("e3", "Untitled", 0),
      s("e2", "New chat", 0),
      s("e1", "Untitled", 0),
    ];
    expect(pickSessionReuse(rows)).toEqual({
      reuseId: "e6",
      pruneIds: ["e5", "e4", "e3", "e2", "e1"],
    });
  });

  it("tolerates string message counts from raw SQL", () => {
    const rows = [s("e1", "Untitled", "0" as unknown as number)];
    expect(pickSessionReuse(rows)).toEqual({ reuseId: "e1", pruneIds: [] });
  });
});
