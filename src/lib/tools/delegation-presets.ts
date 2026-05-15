/**
 * Optional `delegate_to_agent.preset` expansion — kept dependency-free for tests.
 */

export function expandDelegationPreset(
  preset: string | undefined,
  task: string,
  context?: string,
): string {
  const ctxBlock = context?.trim() ? `\n\nAdditional context:\n${context.trim()}` : "";
  switch (preset) {
    case "map_repo":
      return `Read-only repository map: identify key modules, entrypoints, and how they connect. Do not propose file edits.\n\nTask: ${task}${ctxBlock}`;
    case "dependency_web_scout":
      return `Scout dependencies and imports in the repo; use web search only when external version or API facts are needed.\n\nTask: ${task}${ctxBlock}`;
    default:
      return task + (context?.trim() ? `\n\nContext:\n${context.trim()}` : "");
  }
}
