/**
 * Best-effort grouped rollup of delegation tool ledger entries for compact handoffs.
 */

const TERMINAL_TOOLS = new Set([
  "run_command",
  "stream_terminal_output",
]);

const SEARCH_TOOLS = new Set([
  "search",
  "grep",
  "structural_search",
  "search_code",
]);

const READ_TOOLS = new Set([
  "read_file",
  "explore_folder",
  "list_files",
  "get_repo_overview",
  "get_blueprint",
  "get_file_outline",
  "get_project_structure",
  "find_file",
]);

const WEB_TOOLS = new Set(["web_search", "read_url"]);

export type LedgerToolEntry = { toolName: string; summary: string };

function categoryForTool(name: string): string | null {
  if (TERMINAL_TOOLS.has(name)) return "Terminal";
  if (SEARCH_TOOLS.has(name)) return "Search";
  if (READ_TOOLS.has(name)) return "Read / explore";
  if (WEB_TOOLS.has(name)) return "Web";
  return null;
}

export function buildGroupHandoffDigest(
  entries: LedgerToolEntry[],
  proseSummary: string,
): string {
  const byCategory = new Map<string, string[]>();
  for (const e of entries) {
    const cat = categoryForTool(e.toolName);
    if (!cat) continue;
    const list = byCategory.get(cat) ?? [];
    const snippet = e.summary.trim().slice(0, 120);
    if (snippet) list.push(snippet);
    byCategory.set(cat, list);
  }

  const sections: string[] = [];
  for (const [cat, snippets] of byCategory) {
    const unique = [...new Set(snippets)].slice(0, 4);
    const rollup =
      unique.length > 0
        ? unique.join("; ")
        : `${snippets.length} call(s)`;
    sections.push(`**${cat}** (${snippets.length}): ${rollup}`);
  }

  const digest =
    sections.length > 0
      ? `\n\n## Tool groups\n${sections.join("\n")}`
      : "";

  const prose = proseSummary.trim().slice(0, 6000);
  return prose + digest;
}
