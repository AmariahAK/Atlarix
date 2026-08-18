/** User-facing status line for a sub-agent card header. */
export function subagentPhaseLabel(
  agentType: string,
  status: "running" | "done" | "error",
): string {
  const role = agentType.toLowerCase();
  if (status === "done") {
    if (role === "reviewer") return "Review complete";
    if (role === "explore" || role === "scout") return "Explore complete";
    if (role === "research") return "Research complete";
    if (role === "qa") return "Testing complete";
    return "Done";
  }
  if (status === "error") return "Failed";
  if (role === "reviewer") return "Reviewing…";
  if (role === "explore" || role === "scout") return "Exploring…";
  if (role === "research") return "Researching…";
  if (role === "architect") return "Planning…";
  if (role === "qa") return "Testing…";
  if (role === "builder") return "Building…";
  if (role === "debugger") return "Debugging…";
  return "Working…";
}
