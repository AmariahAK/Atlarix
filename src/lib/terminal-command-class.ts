/**
 * Classify shell commands as read-only vs implementation (mutating).
 */

export type TerminalCommandClass = "readonly" | "implementation";

const IMPLEMENTATION_PATTERNS: RegExp[] = [
  /^npm (install|i |ci |run |exec |init|create)/,
  /^npx /,
  /^yarn (install|add|remove|run|exec|create)/,
  /^pnpm (install|add|remove|run|exec|create)/,
  /^pip (install|uninstall)/,
  /^pip3 (install|uninstall)/,
  /^python .*(setup\.py|manage\.py migrate)/,
  /^git (commit|push|pull|fetch|merge|rebase|checkout|switch|branch -[dD]|reset|clean|stash pop|stash drop)/,
  /^rm /,
  /^rmdir /,
  /^mkdir /,
  /^mv /,
  /^cp /,
  /^chmod /,
  /^chown /,
  /^sudo /,
  /^docker (build|run|push|pull|compose up|compose down)/,
  /^make /,
  /^cargo (build|run|install)/,
  /^go (build|run|install|get)/,
];

export function classifyTerminalCommand(command: string): TerminalCommandClass {
  const trimmed = command.trim().toLowerCase();
  for (const pattern of IMPLEMENTATION_PATTERNS) {
    if (pattern.test(trimmed)) return "implementation";
  }
  return "readonly";
}
