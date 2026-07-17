import { describe, it, expect } from "vitest";
import {
  getGitTerminalNote,
  GIT_VIA_TERMINAL_NOTE,
} from "@/lib/tools/mode-prompt-bundle";
import { ATLARIX_CO_AUTHOR_TRAILER } from "@/ipc/utils/git_author";

describe("getGitTerminalNote", () => {
  it("adds the co-author trailer guidance when enabled — and never instructs --author", () => {
    const note = getGitTerminalNote(true);
    expect(note).toContain(GIT_VIA_TERMINAL_NOTE);
    expect(note).toContain(ATLARIX_CO_AUTHOR_TRAILER);
    // User authors the commit; the note must not instruct the model to *use*
    // `--author=...` (it may mention "do not pass --author").
    expect(note).not.toMatch(/--author=/);
    expect(note).toContain("do not pass `--author`");
    expect(note).toContain("Never change the user's git config");
  });

  it("returns the plain git note (no trailer) when the co-author setting is off", () => {
    const note = getGitTerminalNote(false);
    expect(note).toBe(GIT_VIA_TERMINAL_NOTE);
    expect(note).not.toContain("Co-authored-by:");
  });
});
