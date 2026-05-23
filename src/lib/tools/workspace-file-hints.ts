import { getProjectFiles } from "@/ipc/utils/project-files";

/** Repos at or below this size get an explicit path list in tool errors and delegation prompts. */
export const SMALL_REPO_FILE_THRESHOLD = 30;

export async function getWorkspaceRelFilePaths(
  workspacePath: string,
): Promise<{ paths: string[]; count: number }> {
  const { files } = await getProjectFiles(workspacePath);
  return { paths: files, count: files.length };
}

export function formatSmallRepoInventory(paths: string[]): string {
  if (paths.length === 0) {
    return (
      "No tracked files were discovered in this workspace (empty git index or wrong folder). " +
      "Use explore_folder on \".\" or list_files before guessing paths."
    );
  }
  const quoted = paths.map((p) => `"${p}"`).join(", ");
  return (
    `This workspace has only ${paths.length} tracked file(s): ${quoted}. ` +
    "Read or search **only** those paths. Do not probe package.json, tsconfig.json, LICENSE, Dockerfile, or other conventional root files unless they appear in this list. " +
    "Never pass absolute paths (e.g. /Users/...); use workspace-relative paths only."
  );
}

export function isDirectoryReadPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").trim();
  return norm === "" || norm === "." || norm === "./";
}
