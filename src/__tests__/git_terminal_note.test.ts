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
    expect(d).toMatch(/commit, push or open a PR only when asked/i);
    expect(d).toMatch(/force-push/i);
    expect(d).toMatch(/discard work you did not create/i);
  });

  it("does NOT teach git commands the model already knows", () => {
    const d = desc();
    expect(d).not.toMatch(/git status.*git log.*git diff/);
    expect(d).not.toMatch(/\.git\/objects/);
  });

  it("names the live OS and shell right next to the call", () => {
    const d = desc();
    expect(d).toMatch(/Runs on \w+/);
    expect(d).toMatch(/through `[^`]+`/);
  });

  it("does not hardcode a forge: the model picks the CLI the remote uses", () => {
    expect(desc()).not.toMatch(/\bgh\b.*only|use gh\b/i);
  });

  it("frames a quiet job as MAY-not-be-stuck, and does not forbid polling", () => {
    const d = desc();
    expect(d).toMatch(/MAY not be stuck/);
    expect(d).not.toMatch(/never poll/i);
    expect(d).toMatch(/wake_on/);
    expect(d).toMatch(/timeout_ms/);
    expect(d).toMatch(/allow_stalled/);
  });

  it("routes file work away from the shell", () => {
    expect(desc()).toMatch(/read_file \/ edit_file \/ glob \/ grep for file work/);
  });

  it("tells the model how to escape a read-only mode instead of retrying", () => {
    expect(desc()).toMatch(/switch to Build or Debug rather than retrying/i);
  });
});
