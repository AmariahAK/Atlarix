/**
 * Blocks `git init` from AI run_command unless the user opts in via settings.
 * Atlarix never initializes git on behalf of the user by default.
 */

const GIT_INIT_RE =
  /(?:^|[;&|]\s*)(?:sudo\s+)?git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))*\s+init\b/i;

export function isGitInitCommand(command: string): boolean {
  const trimmed = (command || "").trim();
  if (!trimmed) return false;
  return GIT_INIT_RE.test(trimmed);
}

export function runCommandGitInitGateResult(
  command: string,
  allowGitInit: boolean | undefined,
): string | null {
  if (allowGitInit === true) return null;
  if (!isGitInitCommand(command)) return null;
  return JSON.stringify({
    success: false,
    error:
      "git init is blocked by default. Atlarix does not create repositories automatically. " +
      "Initialize git in your project folder manually, or enable allowGitInit in settings if you explicitly want the agent to run git init.",
  });
}
