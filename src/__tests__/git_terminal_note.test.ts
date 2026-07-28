import { describe, it, expect } from "vitest";
import { getCommitAuthoringNote } from "@/lib/tools/mode-prompt-bundle";
import { ATLARIX_CO_AUTHOR_TRAILER } from "@/ipc/utils/git_author";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools";

/**
 * Git guidance moved out of the system prompt and onto `run_command`.
 *
 * The old `GIT_VIA_TERMINAL_NOTE` taught `git status` / `git log` / `git diff` —
 * capability the model already has — and rendered in EVERY mode, including Plan,
 * which has no run_command at all. What the model cannot know is this project's
 * POLICY, so only the policy survives, on the tool it governs.
 *
 * Commit authoring stays in the prompt because it depends on the
 * `includeAtlarixCoAuthor` setting, and tool descriptions are fixed at
 * registration.
 */
describe("getCommitAuthoringNote", () => {
  it("adds the co-author trailer when enabled — and never instructs --author", () => {
    const note = getCommitAuthoringNote(true);
    expect(note).toContain(ATLARIX_CO_AUTHOR_TRAILER);
    expect(note).not.toMatch(/--author=/);
    expect(note).toContain("do not pass `--author`");
    expect(note).toContain("Never change the user's git config");
  });

  it("omits the trailer when the co-author setting is off", () => {
    const note = getCommitAuthoringNote(false);
    expect(note).not.toContain("Co-authored-by:");
    expect(note).toContain("do not pass `--author`");
  });
});

describe("run_command carries the git policy", () => {
  const desc = () => {
    const tool = ToolRegistry.get("run_command");
    expect(tool).toBeTruthy();
    return String(tool!.description);
  };

  it("states policy the model cannot infer", () => {
    const d = desc();
    expect(d).toMatch(/only commit, amend, push or open a PR\/MR when asked/i);
    expect(d).toMatch(/never commit secrets/i);
    expect(d).toMatch(/force-push/i);
    expect(d).toMatch(/do not discard uncommitted work you did not create/i);
    expect(d).toMatch(/`gh`/);
  });

  it("does NOT teach git commands the model already knows", () => {
    const d = desc();
    expect(d).not.toMatch(/git status.*git log.*git diff/);
    expect(d).not.toMatch(/\.git\/objects/);
  });

  it("names the live OS and shell right next to the call", () => {
    const d = desc();
    // Deliberately stated here as well as in deviceInfo: next to the call site is
    // what stops the model inventing bash idioms on a non-bash shell. Only the
    // trailing "do not assume Linux/bash" was dropped — once the OS and shell are
    // named, it adds nothing.
    expect(d).toMatch(/Running on \w+/);
    expect(d).toMatch(/use that shell's syntax and this OS's path conventions/);
    expect(d).not.toMatch(/do not assume Linux\/bash/i);
  });

  it("keeps the forge CLI open-ended instead of hardcoding GitHub", () => {
    const d = desc();
    expect(d).toMatch(/glab/);
    expect(d).toMatch(/Bitbucket/i);
    expect(d).toMatch(/PR\/MR URL/);
  });

  it("frames a quiet job as MAY-not-be-stuck, and does not forbid polling", () => {
    const d = desc();
    expect(d).toMatch(/MAY not be stuck/);
    expect(d).not.toMatch(/never poll/i);
    // Points at the real parameters that cover the case.
    expect(d).toMatch(/wake_on/);
    expect(d).toMatch(/timeout_ms/);
    expect(d).toMatch(/allow_stalled/);
    expect(d).toMatch(/told when one is genuinely stuck/);
  });

  it("routes file work away from the shell", () => {
    const d = desc();
    expect(d).toMatch(/Do NOT use this for file operations/i);
    expect(d).toMatch(/read_file, edit_file, glob and grep/);
  });

  it("tells the model what a failure looks like and how to escape a read-only mode", () => {
    const d = desc();
    expect(d).toMatch(/exit code/i);
    expect(d).toMatch(/switch to Build or Debug rather than retrying/i);
  });
});
