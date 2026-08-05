/**
 * The sandbox states that it was there. It does not diagnose.
 *
 * When a sandboxed command fails and no denied path can be scraped from its output, the
 * model used to be told nothing: not that a sandbox existed, not what its writable roots
 * were, not that a grant was an option. It could not reason about a boundary nobody
 * mentioned. This supplies exactly that missing context.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT TEST is classification, because there isn't any.
 * An earlier version guessed whether a failure was a denial — permission-signal regexes,
 * filesystem-evidence heuristics, a probe for the tool's likely cache directory — and
 * guessing wrong is worse than silence: it explains a failure it does not understand and
 * asks the user to grant a folder unrelated to the problem. The command's output is
 * already in the error the model receives, and the model reads it better than a regex
 * here could.
 */
import { describe, expect, it } from "vitest";
import { describeSandboxFailureContext } from "@/lib/sandbox/sandbox-failure-context";

const base = {
  sandboxed: true,
  workingDir: "/work/project",
  writableRoots: ["/work/project", "/tmp"],
  exitCode: 1,
  alreadyAttributed: false,
};

describe("describeSandboxFailureContext", () => {
  it("states the sandbox, its roots and the cwd", () => {
    const note = describeSandboxFailureContext(base)!;
    expect(note).toContain("write-confining sandbox");
    expect(note).toContain("/work/project");
    expect(note).toContain("/tmp");
  });

  it("states facts and nothing else — no instructions, no verdict", () => {
    // It must not assert that a write WAS refused (it does not know), and must not script
    // what to do about it: the recovery ladder for a failed tool is already in AGENTS.md,
    // and repeating it per failed command is cost without information.
    const note = describeSandboxFailureContext(base)!;
    expect(note).not.toMatch(/\bask the user\b/i);
    expect(note).not.toMatch(/\bre-run\b/i);
    expect(note).not.toMatch(/\bshould\b|\bmust\b/i);
    expect(note).not.toMatch(/\bgrant it\b/i);
    // Every line is an observable fact about how the command was run.
    for (const line of note.split("\n")) {
      expect(line).toMatch(/sandbox|Writable roots|Working directory/i);
    }
  });

  it("says '(none)' rather than nothing when no roots were granted", () => {
    expect(describeSandboxFailureContext({ ...base, writableRoots: [] })).toContain(
      "(none)",
    );
  });

  it("calls out read-only mode, which changes what the roots mean", () => {
    const note = describeSandboxFailureContext({ ...base, readOnly: true })!;
    expect(note).toMatch(/read-only/i);
  });

  it("is silent when the command succeeded", () => {
    expect(describeSandboxFailureContext({ ...base, exitCode: 0 })).toBeNull();
  });

  it("is silent when no sandbox was applied", () => {
    expect(describeSandboxFailureContext({ ...base, sandboxed: false })).toBeNull();
  });

  it("is silent when a path was already attributed", () => {
    // That path gets its own grant card; repeating the context would describe one
    // failure twice, as two different problems.
    expect(
      describeSandboxFailureContext({ ...base, alreadyAttributed: true }),
    ).toBeNull();
  });

  it("says the same thing regardless of what the command printed", () => {
    // The proof there is no classification: the function is not even given the output.
    // A failing test suite and a refused write get identical context, and the model
    // decides which it is from the error it already has.
    const a = describeSandboxFailureContext(base);
    const b = describeSandboxFailureContext({ ...base, exitCode: 137 });
    expect(a).toBe(b);
  });

  it("stays short — it is context, not a lesson", () => {
    expect(describeSandboxFailureContext(base)!.length).toBeLessThan(500);
  });
});
