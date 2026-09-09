/**
 * Read-before-OVERWRITE: `edit_file` refuses a whole-file `write` over a file the agent
 * hasn't read, or read before it changed.
 *
 * SCOPED DELIBERATELY TO `write`, not `replace`. A `replace` already carries its own
 * freshness check — `old_content` must match the file's current bytes, so a stale view
 * fails the match and nothing is written. Gating it too would add a read per file to the
 * path we explicitly tell the agent to prefer ("prefer a surgical replace"), for a hazard
 * that is already handled. An overwrite has no such guard: it discards the entire file,
 * and a stale one destroys work silently. That asymmetry is the whole rule.
 *
 * From a live report: the user pressed Stop mid-task, the agent kept going (fixed
 * separately), re-read a file it had already edited, and concluded that the USER had made
 * the fix — then pushed to git on that belief.
 *
 * The first attempt at this tried to answer "whose edit was it?" so the error could say
 * so. Wrong question, and it needed a chat id the tool funnel never injected into
 * `edit_file`, so it silently never fired. A freshness gate removes the question: an edit
 * cannot proceed from a stale view, so nobody has to work out who changed the file.
 *
 *   - never read      → "read_file <path> first"
 *   - read went stale → "<path> has changed since you last read it"
 *   - after a write   → the record refreshes, so consecutive edits need no re-read
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  __clearAllReadScopes,
  checkFreshness,
  recordFileRead,
  recordFileWrite,
  resolveReadScope,
} from "@/lib/tools/file-read-log";

const SESSION = "sess-abc";

beforeEach(() => {
  __clearAllReadScopes();
});

describe("resolveReadScope — which record a call belongs to", () => {
  it("prefers a writer sub-agent's proposal set over the shared chat", () => {
    // A sub-agent edits against its OWN overlay. If it shared the parent's record, the
    // parent having read a file would satisfy a gate for content the sub-agent never saw.
    expect(
      resolveReadScope({
        _proposalSetId: "p1",
        _scopeSessionId: SESSION,
        _scopeChatId: 3,
      }),
    ).toBe("prop:p1");
  });

  it("prefers the session UUID over the transport chat id", () => {
    // Chat ids are remade every app relaunch; the session id is stable.
    expect(
      resolveReadScope({ _scopeSessionId: SESSION, _scopeChatId: 3 }),
    ).toBe(`sess:${SESSION}`);
  });

  it("falls back to a chat id, including the one sub-agents pass", () => {
    expect(resolveReadScope({ _scopeChatId: 3 })).toBe("chat:3");
    expect(resolveReadScope({ _chatSessionId: 9 })).toBe("chat:9");
  });

  it("returns null when nothing identifies the call", () => {
    expect(resolveReadScope({})).toBeNull();
  });
});

describe("checkFreshness", () => {
  const scope = `sess:${SESSION}`;

  it("passes when the content matches what was read", () => {
    recordFileRead(scope, "admin.go", "package main\n");
    expect(checkFreshness(scope, "admin.go", "package main\n")).toEqual({
      ok: true,
    });
  });

  it("reports never_read for a file this scope has not read", () => {
    expect(checkFreshness(scope, "admin.go", "package main\n")).toEqual({
      ok: false,
      reason: "never_read",
    });
  });

  it("reports stale when the bytes moved under the agent", () => {
    recordFileRead(scope, "admin.go", "package main\n");
    expect(
      checkFreshness(scope, "admin.go", "package main\n// changed\n"),
    ).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("refreshes after a write, so consecutive edits need no re-read", () => {
    // This is what keeps the gate from being punitive — having just written the file, the
    // agent knows its contents exactly.
    recordFileRead(scope, "admin.go", "v1\n");
    recordFileWrite(scope, "admin.go", "v2\n");
    expect(checkFreshness(scope, "admin.go", "v2\n")).toEqual({ ok: true });
  });

  it("keeps records separate per scope", () => {
    recordFileRead("sess:a", "admin.go", "x\n");
    expect(checkFreshness("sess:b", "admin.go", "x\n").ok).toBe(false);
  });

  it("normalizes ./ and backslashes so the same file compares equal", () => {
    recordFileRead(scope, "./src/admin.go", "x\n");
    expect(checkFreshness(scope, "src/admin.go", "x\n").ok).toBe(true);
    recordFileRead(scope, "src\\win\\a.ts", "y\n");
    expect(checkFreshness(scope, "src/win/a.ts", "y\n").ok).toBe(true);
  });

  /**
   * FAIL OPEN, deliberately. An un-scoped caller is a harness gap; refusing every edit
   * would be a far worse failure than allowing an unverified one.
   */
  it("passes when there is no scope at all", () => {
    expect(checkFreshness(null, "admin.go", "anything")).toEqual({ ok: true });
  });
});

describe("edit_file end-to-end gate", () => {
  let dir: string;
  const REL = "admin.go";
  const V1 = "package main\n\nfunc main() {}\n";

  beforeEach(async () => {
    __clearAllReadScopes();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-readgate-"));
    await fs.writeFile(path.join(dir, REL), V1, "utf8");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const scopeArgs = { _scopeSessionId: SESSION, _scopeChatId: 1 };

  async function callTool(name: string, args: Record<string, unknown>) {
    const { ToolRegistry } = await import("@/lib/tools/registry");
    await import("@/lib/tools");
    return (await ToolRegistry.get(name)!.handler({
      workspace: dir,
      chatMode: "build",
      ...scopeArgs,
      ...args,
    })) as Record<string, unknown>;
  }

  const readIt = () => callTool("read_file", { path: REL });

  it("does NOT gate a replace — old_content matching is already the freshness check", async () => {
    const res = await callTool("edit_file", {
      path: REL,
      operation: "replace",
      old_content: "func main() {}",
      new_content: "func main() { return }",
    });
    expect(res.error).toBeUndefined();
    expect(res.__permission_required).toBe(true);
  });

  it("a stale replace fails on the MATCH, harmlessly, with nothing written", async () => {
    // Why `replace` needs no gate: the guard is content-addressed and more precise than
    // any whole-file hash — it protects the exact region being edited.
    const res = await callTool("edit_file", {
      path: REL,
      operation: "replace",
      old_content: "func main() { alreadyChanged() }",
      new_content: "x",
    });
    expect(String(res.error)).toContain("Content to replace not found");
    expect(res.__permission_required).toBeUndefined();
    expect(await fs.readFile(path.join(dir, REL), "utf8")).toBe(V1);
  });

  it("allows a replace after a read too", async () => {
    await readIt();
    const res = await callTool("edit_file", {
      path: REL,
      operation: "replace",
      old_content: "func main() {}",
      new_content: "func main() { return }",
    });
    expect(res.error).toBeUndefined();
    expect(res.__permission_required).toBe(true);
  });

  it("refuses an OVERWRITE when the file changed after the read", async () => {
    await readIt();
    // Someone (the user, another tool, an earlier landed write) changes it.
    await fs.writeFile(path.join(dir, REL), `${V1}// changed\n`, "utf8");
    const res = await callTool("edit_file", {
      path: REL,
      operation: "write",
      content: "package main\n",
    });
    expect(String(res.error)).toContain("has changed since you last read it");
    expect((res.retry as { reason?: string } | undefined)?.reason).toBe(
      "stale_read",
    );
    // Crucially it does NOT speculate about WHO changed it — that guess is what made a
    // model conclude the user had already applied its fix.
    expect(String(res.error)).not.toContain("YOU already edited");
  });

  it("allows the overwrite once the file has been read", async () => {
    await readIt();
    const res = await callTool("edit_file", {
      path: REL,
      operation: "write",
      content: "package main\n",
    });
    expect(res.error).toBeUndefined();
    expect(res.__permission_required).toBe(true);
  });

  it("gates an overwrite of an existing file too", async () => {
    // A full write discards everything in the file — the most destructive operation, and
    // the one that most needs the agent to have seen what it is discarding.
    const res = await callTool("edit_file", {
      path: REL,
      operation: "write",
      content: "package main\n",
    });
    expect(String(res.error)).toContain(`Read ${REL} before overwriting it`);
    expect((res.retry as { reason?: string } | undefined)?.reason).toBe(
      "not_read",
    );
  });

  it("does NOT gate creating a new file — there is nothing to have read", async () => {
    const res = await callTool("edit_file", {
      path: "brand-new.go",
      operation: "write",
      content: "package main\n",
    });
    expect(res.error).toBeUndefined();
    expect(res.__permission_required).toBe(true);
  });

  it("a plain no-match no longer blames the file for changing", async () => {
    await readIt();
    const res = await callTool("edit_file", {
      path: REL,
      operation: "replace",
      old_content: "func nowhere() {}",
      new_content: "x",
    });
    // The gate already established the view is current, so the only honest explanation
    // left is that old_content doesn't match — believing otherwise is what made a model
    // decide the user had applied its fix.
    expect(String(res.error)).toContain("Content to replace not found");
    expect(String(res.error)).not.toContain("changed since you read it");
    expect(String(res.error)).not.toContain("likely changed");
  });
});
