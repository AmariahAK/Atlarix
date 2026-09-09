import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import { memoryDirFor, setAgentMemoryRootOverride } from "@/lib/agent-memory";

/**
 * Agent memory lives OUTSIDE the repo on purpose — per-developer, never
 * committed. That also put it on the wrong side of the interceptor's
 * outside-workspace check, so the prompt handed the agent an absolute path, told
 * it to write a note there, and every attempt threw "Path is outside workspace".
 * Memory was readable and un-writable.
 */

const tmpRoots: string[] = [];

function makeWorkspace(): string {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-mem-")),
  );
  tmpRoots.push(base);
  const ws = path.join(base, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  setAgentMemoryRootOverride(base);
  return ws;
}

/** The containment check is private; this is the seam under test. */
function resolveWrite(ws: string, target: string): string {
  const i = new PermissionInterceptor(ws) as unknown as {
    resolvePathWithinWorkspace: (p: string) => string;
  };
  return i.resolvePathWithinWorkspace(target);
}

afterEach(() => {
  setAgentMemoryRootOverride(null);
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent memory is writable through the approval gate", () => {
  it("accepts a note path inside this workspace's memory dir", () => {
    const ws = makeWorkspace();
    const note = path.join(memoryDirFor(ws), "some-fact.md");
    expect(resolveWrite(ws, note)).toBe(path.resolve(note));
  });

  it("accepts the index file", () => {
    const ws = makeWorkspace();
    const index = path.join(memoryDirFor(ws), "MEMORY.md");
    expect(resolveWrite(ws, index)).toBe(path.resolve(index));
  });

  it("does NOT open the whole global .atlarix dir", () => {
    // Only this project's memory directory — not settings, not credentials.
    const ws = makeWorkspace();
    const outside = path.join(
      path.dirname(path.dirname(memoryDirFor(ws))),
      "settings.json",
    );
    expect(() => resolveWrite(ws, outside)).toThrow(/outside workspace/i);
  });

  it("does NOT open another project's notes", () => {
    const ws = makeWorkspace();
    const otherWs = path.join(path.dirname(ws), "other-workspace");
    fs.mkdirSync(otherWs, { recursive: true });
    const theirNote = path.join(memoryDirFor(otherWs), "their-fact.md");
    expect(() => resolveWrite(ws, theirNote)).toThrow(/outside workspace/i);
  });

  it("still refuses an unrelated absolute path", () => {
    const ws = makeWorkspace();
    expect(() =>
      resolveWrite(ws, path.join(os.tmpdir(), "elsewhere.md")),
    ).toThrow(/outside workspace/i);
  });

  // Writable is not the same as invisible. The memory directory's relative form
  // is `../…/.atlarix/projects/<slug>/memory/…`, which the blanket `.atlarix/**`
  // allowance matched on the substring `/.atlarix/` — so notes were landing with
  // no approval card at all, contradicting this interceptor's own comment.
  it("does NOT silently auto-approve a memory note — the user still sees it", () => {
    const ws = makeWorkspace();
    const i = new PermissionInterceptor(ws) as unknown as {
      shouldAlwaysAutoApprove: (r: unknown) => boolean;
    };
    const silent = i.shouldAlwaysAutoApprove({
      // `edit_file`, not the retired `write_file`: it is the only operation that
      // writes file content now, and asking about a name with no producer would
      // have this assert the fail-closed default instead of the rule it is about.
      operation: "edit_file",
      preview: { path: path.join(memoryDirFor(ws), "some-fact.md") },
    });
    expect(silent).toBe(false);
  });

  it("still auto-approves this workspace's own .atlarix agent files", () => {
    const ws = makeWorkspace();
    const i = new PermissionInterceptor(ws) as unknown as {
      shouldAlwaysAutoApprove: (r: unknown) => boolean;
    };
    expect(
      i.shouldAlwaysAutoApprove({
        operation: "edit_file",
        preview: { path: path.join(ws, ".atlarix", "plans", "current.md") },
      }),
    ).toBe(true);
  });
});
