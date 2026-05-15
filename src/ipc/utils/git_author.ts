import { getGithubUser } from "../handlers/github_handlers";

export async function getGitAuthor() {
  const user = await getGithubUser();
  const author = user
    ? {
        name: `[atlarix]`,
        email: user.email,
      }
    : {
        name: "[atlarix]",
        email: "git@atlarix.dev",
      };
  return author;
}
