import { describe, it, expect } from "vitest";
import {
  ATLARIX_CO_AUTHOR_TRAILER,
  ATLARIX_GIT_AUTHOR_EMAIL,
  ATLARIX_GIT_AUTHOR_NAME,
  getGitAuthor,
} from "@/ipc/utils/git_author";

describe("getGitAuthor", () => {
  it("returns canonical atlarix-agent identity", async () => {
    const author = await getGitAuthor();
    expect(author).toEqual({
      name: ATLARIX_GIT_AUTHOR_NAME,
      email: ATLARIX_GIT_AUTHOR_EMAIL,
    });
    expect(author.name).toBe("atlarix-agent");
    expect(author.email).toBe("agent@atlarix.dev");
    expect(author.name).not.toContain("[atlarix]");
  });
});

describe("ATLARIX_CO_AUTHOR_TRAILER", () => {
  it("matches author name and email", () => {
    expect(ATLARIX_CO_AUTHOR_TRAILER).toBe(
      "Co-authored-by: atlarix-agent <agent@atlarix.dev>",
    );
  });
});
