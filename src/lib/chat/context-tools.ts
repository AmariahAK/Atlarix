/** Read-only / exploration tools grouped like OpenCode "Gathered context". */
export const CONTEXT_TOOL_NAMES = new Set([
  "get_repo_overview",
  "explore_folder",
  "list_files",
  "read_file",
  "search_code",
  "search",
  "grep",
  "structural_search",
  "get_blueprint",
  "web_search",
]);

export function isContextToolName(name: string): boolean {
  return CONTEXT_TOOL_NAMES.has(name);
}
