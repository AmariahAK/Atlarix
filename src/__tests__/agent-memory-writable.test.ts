import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import { memoryDirFor, setAgentMemoryRootOverride } from "@/lib/agent-memory";
import { agentScratchDirFor } from "@/lib/agent-scratch";

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
    // NOT a temp path any more: the OS temp roots are deliberately writable for
    // file tools now (see the constructor), because the prompt hands the agent a
    // scratch directory under them by name. Use a path that is genuinely nobody's
    // business instead — which is what this test was always about.
    expect(() => resolveWrite(ws, path.join(os.homedir(), ".zshrc"))).toThrow(
      /outside workspace/i,
    );
    expect(() => resolveWrite(ws, "/etc/hosts")).toThrow(/outside workspace/i);
  });

  it("THIS workspace's scratch directory is writable", () => {
    const ws = makeWorkspace();
    // The runtime identity block publishes `<tmp>/atlarix-scratch/<slug>` and
    // tells the model to put temp files there rather than guessing. Before this,
    // `edit_file` threw "Path is outside workspace" on the path the prompt had
    // just given it, so shelling out was the only way to write a file it had
    // been told to write.
    expect(() =>
      resolveWrite(ws, path.join(agentScratchDirFor(ws), "note.md")),
    ).not.toThrow();
  });

  it("but a bare temp path is still outside", () => {
    // Per-workspace, not the whole temp root — granting `os.tmpdir()` made
    // "outside the workspace" meaningless, since the suite's own workspaces
    // live there.
    const ws = makeWorkspace();
    expect(() => resolveWrite(ws, path.join(os.tmpdir(), "loose.md"))).toThrow(
      /outside workspace/i,
    );
  });

  /**
   * A memory note auto-approves — POLICY CHANGE, 2026-09-22, owner's call.
   *
   * This test previously asserted the opposite, and the reason it did still
   * matters: the blanket `.atlarix/**` allowance matched on the SUBSTRING
   * `/.atlarix/`, and the memory directory's relative form is
   * `../…/.atlarix/projects/<slug>/memory/…` — so it matched, and so did
   * `../other-repo/.atlarix/hooks/hooks.json`. Notes landed silently as a side
   * effect of a rule that also handed over another project's hooks.
   *
   * What changed is the mechanism, not the caution. The allowance is now
   * CONTAINMENT against this workspace's own resolved memory root
   * (`auto-writable-paths.ts`), so a sibling, a `..` traversal and a shared name
   * prefix all still fail — see `auto-writable-paths.test.ts`, which is most of
   * that file. The card was costing a click per note on a path the prompt itself
   * told the agent to write to.
   */
  it("auto-approves a note in THIS workspace's memory", () => {
    const ws = makeWorkspace();
    const i = new PermissionInterceptor(ws) as unknown as {
      shouldAlwaysAutoApprove: (r: unknown) => boolean;
    };
    expect(
      i.shouldAlwaysAutoApprove({
        // `edit_file`, not the retired `write_file`: it is the only operation
        // that writes file content now.
        operation: "edit_file",
        preview: { path: path.join(memoryDirFor(ws), "some-fact.md") },
      }),
    ).toBe(true);
  });

  it("does NOT auto-approve another project's memory or agent files", () => {
    const ws = makeWorkspace();
    const otherWs = path.join(path.dirname(ws), "other-workspace");
    const i = new PermissionInterceptor(ws) as unknown as {
      shouldAlwaysAutoApprove: (r: unknown) => boolean;
    };
    for (const p of [
      path.join(memoryDirFor(otherWs), "their-fact.md"),
      path.join(otherWs, ".atlarix", "hooks", "hooks.json"),
    ]) {
      expect(
        i.shouldAlwaysAutoApprove({
          operation: "edit_file",
          preview: { path: p },
        }),
      ).toBe(false);
    }
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
