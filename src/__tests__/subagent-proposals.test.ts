/**
 * Writer sub-agent proposals — the machinery that replaced the git worktree.
 *
 * What's actually load-bearing here, and therefore what's tested:
 *
 *   - a sub-agent must see its OWN edits on re-read. This is the whole reason
 *     the overlay exists; without it a second edit to one file matches against
 *     content the first edit already replaced, and silently fails.
 *   - the merge BASE must never drift. It's captured at first touch, and a
 *     later edit's `oldContent` is the overlay's own body — adopting that would
 *     erase the real pre-run state and make the staleness check meaningless.
 *   - accepting must write the sub-agent's exact bytes, and must refuse rather
 *     than guess when the file moved underneath.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __clearAllProposalSets,
  createProposalSet,
  getProposalSet,
  overlayContent,
  recordEditProposal,
} from "@/lib/agents/subagent-proposals";
import {
  findProposalConflicts,
  rebaseOntoCurrent,
} from "@/lib/agents/subagent-proposal-review";

const WS = "/tmp/atlarix-proposal-ws";

function envelope(rel: string, content: string, oldContent?: string) {
  return {
    __permission_required: true,
    operation: "edit_file",
    preview: {
      path: rel,
      content,
      ...(oldContent !== undefined ? { oldContent } : {}),
      type: oldContent === undefined ? ("create" as const) : ("update" as const),
    },
  };
}

beforeEach(() => __clearAllProposalSets());

describe("the overlay", () => {
  it("serves a sub-agent its own proposed body on re-read", () => {
    const id = createProposalSet({
      chatId: 1,
      taskId: "t1",
      agentName: "writer",
      workspace: WS,
    });
    recordEditProposal(id, envelope("a.ts", "v2\n", "v1\n"));
    expect(overlayContent(id, path.join(WS, "a.ts"))).toBe("v2\n");
  });

  it("does not leak between sub-agents", () => {
    const a = createProposalSet({ chatId: 1, taskId: "ta", agentName: "a", workspace: WS });
    const b = createProposalSet({ chatId: 1, taskId: "tb", agentName: "b", workspace: WS });
    recordEditProposal(a, envelope("a.ts", "from-a\n", "v1\n"));
    expect(overlayContent(b, path.join(WS, "a.ts"))).toBeNull();
  });

  it("returns null for an untouched file so the caller reads disk", () => {
    const id = createProposalSet({ chatId: 1, taskId: "t1", agentName: "w", workspace: WS });
    expect(overlayContent(id, path.join(WS, "never-touched.ts"))).toBeNull();
  });
});

describe("capture", () => {
  it("keeps the ORIGINAL base across repeated edits to one file", () => {
    const id = createProposalSet({ chatId: 1, taskId: "t1", agentName: "w", workspace: WS });
    recordEditProposal(id, envelope("a.ts", "v2\n", "v1\n"));
    // The second edit's oldContent is the OVERLAY's body, not disk. Adopting it
    // as the base would lose "v1" and defeat the staleness check at accept time.
    recordEditProposal(id, envelope("a.ts", "v3\n", "v2\n"));

    const file = getProposalSet(id)!.files.get(path.join(WS, "a.ts"))!;
    expect(file.baseContent).toBe("v1\n");
    expect(file.content).toBe("v3\n");
    expect(file.edits).toBe(2);
  });

  it("keeps type=create even when the file is rewritten later", () => {
    const id = createProposalSet({ chatId: 1, taskId: "t1", agentName: "w", workspace: WS });
    recordEditProposal(id, envelope("new.ts", "first\n"));
    recordEditProposal(id, envelope("new.ts", "second\n", "first\n"));
    const file = getProposalSet(id)!.files.get(path.join(WS, "new.ts"))!;
    expect(file.type).toBe("create");
    expect(file.baseContent).toBeNull();
  });

  it("ignores anything that isn't an edit_file proposal", () => {
    const id = createProposalSet({ chatId: 1, taskId: "t1", agentName: "w", workspace: WS });
    expect(recordEditProposal(id, { success: false, error: "nope" })).toBeNull();
    expect(recordEditProposal(id, { __permission_required: true, operation: "run_command" })).toBeNull();
    expect(getProposalSet(id)!.files.size).toBe(0);
  });

  it("refuses a body over the per-file cap instead of holding it", () => {
    const id = createProposalSet({ chatId: 1, taskId: "t1", agentName: "w", workspace: WS });
    const huge = "x".repeat(3 * 1024 * 1024);
    expect(() => recordEditProposal(id, envelope("big.ts", huge, "small\n"))).toThrow(
      /per-file limit/,
    );
  });
});

describe("rebase at accept time", () => {
  const base = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");

  it("is byte-exact when the file has not moved", () => {
    const proposed = base.replace("four", "FOUR");
    const r = rebaseOntoCurrent(base, proposed, base);
    expect(r.ok && r.content).toBe(proposed);
    expect(r.ok && r.rebased).toBe(false);
  });

  it("re-anchors onto a disjoint change made underneath it", () => {
    const proposed = base.replace("two", "TWO");
    // Someone else changed a different region while the sub-agent was running.
    const current = base.replace("seven", "SEVEN");
    const r = rebaseOntoCurrent(base, proposed, current);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rebased).toBe(true);
      expect(r.content).toContain("TWO"); // the sub-agent's change landed
      expect(r.content).toContain("SEVEN"); // and the other change survived
    }
  });

  it("REFUSES when the proposal's own lines were changed underneath it", () => {
    const proposed = base.replace("four", "FOUR");
    const current = base.replace("four", "QUATRE");
    const r = rebaseOntoCurrent(base, proposed, current);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/no longer match/);
      expect(r.failingHunks.length).toBeGreaterThan(0);
    }
  });

  it("treats an already-applied file as a no-op rather than a conflict", () => {
    const proposed = base.replace("four", "FOUR");
    const r = rebaseOntoCurrent(base, proposed, proposed);
    expect(r.ok && r.content).toBe(proposed);
  });
});

describe("conflicts between two sub-agents", () => {
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

  function setWith(name: string, content: string) {
    const id = createProposalSet({
      chatId: 1,
      taskId: `t-${name}`,
      agentName: name,
      workspace: WS,
    });
    recordEditProposal(id, envelope("shared.ts", content, base));
    return getProposalSet(id)!;
  }

  it("does not flag edits to different parts of one file", () => {
    const a = setWith("agent-a", base.replace("line 2", "A"));
    const b = setWith("agent-b", base.replace("line 35", "B"));
    const conflicts = findProposalConflicts([a, b]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].overlapping).toBe(false);
    expect(conflicts[0].agents).toEqual(["agent-a", "agent-b"]);
  });

  it("flags edits to the same lines", () => {
    const a = setWith("agent-a", base.replace("line 20", "A"));
    const b = setWith("agent-b", base.replace("line 20", "B"));
    const conflicts = findProposalConflicts([a, b]);
    expect(conflicts[0].overlapping).toBe(true);
  });

  it("says nothing when only one sub-agent touched a file", () => {
    const a = setWith("agent-a", base.replace("line 2", "A"));
    expect(findProposalConflicts([a])).toHaveLength(0);
  });
});

describe("accepting through the proposals tool", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-accept-"));
  });

  it("returns an edit_file permission envelope carrying the exact proposed bytes", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    fs.writeFileSync(path.join(ws, "a.ts"), "before\n");

    const id = createProposalSet({
      chatId: 42,
      taskId: "t1",
      agentName: "impl auth",
      workspace: ws,
    });
    recordEditProposal(id, envelope("a.ts", "after\n", "before\n"));

    const out = (await ToolRegistry.execute("proposals", {
      operation: "accept",
      proposal: "impl auth", // by NAME, not id
      file: "a.ts",
      chatMode: "build",
      _chatSessionId: 42,
      workspace: ws,
    })) as Record<string, unknown>;

    // The envelope the interceptor routes on — same shape edit_file produces,
    // which is what makes the human approval gate behave identically.
    expect(out.__permission_required).toBe(true);
    expect(out.operation).toBe("edit_file");
    const preview = out.preview as Record<string, unknown>;
    expect(preview.path).toBe("a.ts");
    expect(preview.content).toBe("after\n");
    expect(preview.oldContent).toBe("before\n");
  });

  it("refuses to accept in a read-only mode even if the allowlist let it through", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const id = createProposalSet({
      chatId: 43,
      taskId: "t1",
      agentName: "w",
      workspace: ws,
    });
    recordEditProposal(id, envelope("a.ts", "after\n", "before\n"));

    const out = (await ToolRegistry.execute("proposals", {
      operation: "accept",
      proposal: "w",
      file: "a.ts",
      chatMode: "plan",
      _chatSessionId: 43,
      workspace: ws,
      // A failing tool result is FLAT (registry.ts spreads it), not nested
      // under `result` the way a success is.
    })) as { denied?: boolean };
    expect(out.denied).toBe(true);
  });

  it("names the candidates when a file reference doesn't match", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const id = createProposalSet({
      chatId: 44,
      taskId: "t1",
      agentName: "w",
      workspace: ws,
    });
    recordEditProposal(id, envelope("src/auth/session.ts", "after\n", "before\n"));

    const out = (await ToolRegistry.execute("proposals", {
      operation: "show",
      proposal: "w",
      file: "nope.ts",
      chatMode: "build",
      _chatSessionId: 44,
      workspace: ws,
    })) as { error?: string };
    expect(out.error).toContain("src/auth/session.ts");
  });

  it("finds a file by a unique suffix", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const id = createProposalSet({
      chatId: 45,
      taskId: "t1",
      agentName: "w",
      workspace: ws,
    });
    recordEditProposal(id, envelope("src/auth/session.ts", "after\n", "before\n"));

    const out = (await ToolRegistry.execute("proposals", {
      operation: "show",
      proposal: "w",
      file: "session.ts",
      chatMode: "build",
      _chatSessionId: 45,
      workspace: ws,
    })) as { result?: { file?: string; diff?: string } };
    expect(out.result?.file).toBe("src/auth/session.ts");
    expect(out.result?.diff).toContain("+after");
  });

  it("rejecting drops the file and writes nothing", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const target = path.join(ws, "a.ts");
    fs.writeFileSync(target, "before\n");

    const id = createProposalSet({
      chatId: 46,
      taskId: "t1",
      agentName: "w",
      workspace: ws,
    });
    recordEditProposal(id, envelope("a.ts", "after\n", "before\n"));

    const out = (await ToolRegistry.execute("proposals", {
      operation: "reject",
      proposal: "w",
      file: "a.ts",
      reason: "wrong approach",
      chatMode: "build",
      _chatSessionId: 46,
      workspace: ws,
    })) as { result?: { rejected?: string; remaining?: number } };

    expect(out.result?.rejected).toBe("a.ts");
    expect(out.result?.remaining).toBe(0);
    expect(fs.readFileSync(target, "utf-8")).toBe("before\n");
    expect(getProposalSet(id)).toBeNull(); // empty set is dropped
  });

  it("refuses a stale file and says nothing was written", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const target = path.join(ws, "a.ts");
    const base = ["a", "b", "c", "d", "e"].join("\n");
    fs.writeFileSync(target, base);

    const id = createProposalSet({
      chatId: 47,
      taskId: "t1",
      agentName: "w",
      workspace: ws,
    });
    recordEditProposal(id, envelope("a.ts", base.replace("c", "C"), base));
    // Someone edits the very same line while the review is pending.
    fs.writeFileSync(target, base.replace("c", "ZZZ"));

    const out = (await ToolRegistry.execute("proposals", {
      operation: "accept",
      proposal: "w",
      file: "a.ts",
      chatMode: "build",
      _chatSessionId: 47,
      workspace: ws,
    })) as { success?: boolean; error?: string };

    expect(out.success).toBe(false);
    expect(out.error).toContain("Nothing was written");
    expect(fs.readFileSync(target, "utf-8")).toContain("ZZZ");
  });
});

describe("sequential edits through the real edit_file tool", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-seq-"));
  });

  /** What run-subagent's tool funnel does: execute, then capture the envelope. */
  async function subagentEdit(
    setId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { ToolRegistry } = await import("@/lib/tools/registry");
    const result = await ToolRegistry.execute("edit_file", {
      ...args,
      workspace: ws,
      chatMode: "build",
      _proposalSetId: setId,
    });
    recordEditProposal(setId, result);
    return result;
  }

  it("lets a sub-agent edit the same file three times", async () => {
    await import("@/lib/tools/index");
    const target = path.join(ws, "a.ts");
    fs.writeFileSync(target, "one\ntwo\nthree\n");

    const id = createProposalSet({
      chatId: 60,
      taskId: "t1",
      agentName: "w",
      workspace: ws,
    });

    // Each replace matches against the PREVIOUS proposal, not disk. Without the
    // overlay the second call fails: "two" was already replaced in-proposal.
    await subagentEdit(id, {
      path: "a.ts",
      operation: "replace",
      old_content: "one",
      new_content: "ONE",
    });
    await subagentEdit(id, {
      path: "a.ts",
      operation: "replace",
      old_content: "two",
      new_content: "TWO",
    });
    await subagentEdit(id, {
      path: "a.ts",
      operation: "replace",
      old_content: "three",
      new_content: "THREE",
    });

    const file = getProposalSet(id)!.files.get(target)!;
    expect(file.content).toBe("ONE\nTWO\nTHREE\n");
    expect(file.baseContent).toBe("one\ntwo\nthree\n");
    // Nothing reached disk.
    expect(fs.readFileSync(target, "utf-8")).toBe("one\ntwo\nthree\n");
  });

  it("lets a sub-agent create a file and then edit it", async () => {
    await import("@/lib/tools/index");
    const id = createProposalSet({
      chatId: 61,
      taskId: "t1",
      agentName: "w",
      workspace: ws,
    });

    await subagentEdit(id, {
      path: "new.ts",
      operation: "write",
      content: "export const a = 1;\n",
    });
    // Editing a file that exists ONLY in the overlay — there is nothing on disk
    // to read, so this is the case a naive implementation fails outright.
    await subagentEdit(id, {
      path: "new.ts",
      operation: "replace",
      old_content: "a = 1",
      new_content: "a = 2",
    });

    const file = getProposalSet(id)!.files.get(path.join(ws, "new.ts"))!;
    expect(file.content).toBe("export const a = 2;\n");
    expect(file.type).toBe("create");
    expect(fs.existsSync(path.join(ws, "new.ts"))).toBe(false);
  });

  it("lets a sub-agent read back what it proposed", async () => {
    await import("@/lib/tools/index");
    const { ToolRegistry } = await import("@/lib/tools/registry");
    fs.writeFileSync(path.join(ws, "a.ts"), "before\n");

    const id = createProposalSet({
      chatId: 62,
      taskId: "t1",
      agentName: "w",
      workspace: ws,
    });
    await subagentEdit(id, {
      path: "a.ts",
      operation: "write",
      content: "after\n",
    });

    const read = (await ToolRegistry.execute("read_file", {
      path: "a.ts",
      workspace: ws,
      _proposalSetId: id,
    })) as { result?: string };
    expect(String(read.result)).toContain("after");
    expect(String(read.result)).not.toContain("before");

    // The MAIN agent, with no proposal set, still sees disk.
    const mainRead = (await ToolRegistry.execute("read_file", {
      path: "a.ts",
      workspace: ws,
    })) as { result?: string };
    expect(String(mainRead.result)).toContain("before");
  });
});
