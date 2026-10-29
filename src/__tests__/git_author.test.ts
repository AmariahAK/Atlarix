/**
 * Atlarix's git identity (owner, 2026-10-29): the user is the author of every
 * commit the agent runs; Atlarix is credited only by a co-author trailer, on the
 * atlarix-agent GitHub account's noreply address, never agent@atlarix.dev (the
 * QA account's login, which would be public on every commit).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATLARIX_CO_AUTHOR_TRAILER,
  ATLARIX_GIT_AUTHOR_EMAIL,
} from "@/ipc/utils/git_author";

const src = (p: string) =>
  readFileSync(path.join(__dirname, "..", p), "utf8");

describe("Atlarix's git identity", () => {
  it("credits atlarix-agent on its GitHub noreply address", () => {
    expect(ATLARIX_CO_AUTHOR_TRAILER).toBe(
      "Co-authored-by: atlarix-agent <261929375+atlarix-agent@users.noreply.github.com>",
    );
    expect(ATLARIX_GIT_AUTHOR_EMAIL).not.toContain("atlarix.dev");
  });

  it("a commit the agent runs is never rewritten to another author", () => {
    const interceptor = src("ipc/handlers/permissions/interceptor.ts");
    expect(interceptor).not.toMatch(/injectAgentGitIdentity|user\.email|--author/);
  });
});
