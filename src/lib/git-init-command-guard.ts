/**
 * Gate for `git init` from AI run_command.
 *
 * v13.8: git is agent-managed (terminal-first), and every run_command already
 * goes through the approval queue — the user sees and approves the exact
 * `git init` (with its cwd) before it runs. So git init is ALLOWED by default;
 * the `allowGitInit: false` setting remains as an explicit opt-out for users who
 * never want the agent to create a repository.
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
  // Allowed by default; only an explicit `allowGitInit: false` blocks it.
  if (allowGitInit !== false) return null;
  if (!isGitInitCommand(command)) return null;
  return JSON.stringify({
    success: false,
    error:
      "git init is disabled in this workspace's settings (allowGitInit: false). " +
      "Re-enable it in Settings if you want the agent to initialize a repository.",
  });
}
