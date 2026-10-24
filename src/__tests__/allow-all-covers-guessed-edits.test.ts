/**
 * 15.11.0 (ai-c8, filming): after "Allow all this turn", the next edit in the
 * same turn still asked: it was a fuzzy match, and a guessed edit always faced a
 * human. Owner, 15.11.1: "Allow all this turn" covers guessed edits too, and the
 * agent-memory folder never asks (it is the agent's notepad).
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import { shouldSkipPermissionWait } from "@/ipc/handlers/chat_stream/permission-ui";
import { memoryDirFor, setAgentMemoryRootOverride } from "@/lib/agent-memory";

const roots: string[] = [];
function workspace(): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-allowall-")));
  roots.push(base);
  const ws = path.join(base, "ws");
  fs.mkdirSync(ws, { recursive: true });
  setAgentMemoryRootOverride(base);
  return ws;
}
afterEach(() => {
  setAgentMemoryRootOverride(null);
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const fuzzyEdit = (p: string) => ({
  operation: "edit_file",
  preview: { path: p, content: "x", notice: "Matched by block anchor (fuzzy)" },
});

function decide(i: PermissionInterceptor, req: ReturnType<typeof fuzzyEdit>, autoApproved = false): boolean {
  return shouldSkipPermissionWait(req, {
    reviewOverridden: i.overridesEditReview(req as never),
    autoApproved: autoApproved || i.shouldAlwaysAutoApprove(req as never),
  });
}

describe("a guessed edit and the user's yes", () => {
  it("\"Allow all this turn\" covers the next guessed edit in the turn", () => {
    const ws = workspace();
    const i = new PermissionInterceptor(ws);
    const req = fuzzyEdit(path.join(ws, "src", "server.js"));
    expect(decide(i, req)).toBe(false); // asks before the click
    i.approveRestOfTurn();
    expect(decide(i, req)).toBe(true);
  });

  it("a write into the agent-memory folder never asks, even with a notice", () => {
    const ws = workspace();
    const i = new PermissionInterceptor(ws);
    const note = { ...fuzzyEdit(path.join(memoryDirFor(ws), "notes.md")) };
    note.preview.notice = "Project memory is getting large.";
    expect(decide(i, note)).toBe(true);
  });

  it("without the click, a guessed edit in the workspace still asks", () => {
    const ws = workspace();
    const i = new PermissionInterceptor(ws);
    expect(decide(i, fuzzyEdit(path.join(ws, "a.ts")), true)).toBe(false);
  });
});
