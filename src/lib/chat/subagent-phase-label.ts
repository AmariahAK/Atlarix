/** User-facing status line for a sub-agent card header. */
export function subagentPhaseLabel(
  agentType: string,
  status: "running" | "done" | "error",
): string {
  const role = agentType.toLowerCase();
  if (status === "done") {
    if (role === "reviewer") return "Review complete";
    if (role === "explore" || role === "explorer" || role === "scout") {
      return "Explore complete";
    }
    if (role === "research") return "Research complete";
    if (role === "build" || role === "implementer") return "Build complete";
    return "Done";
  }
  if (status === "error") return "Failed";
  if (role === "reviewer") return "Reviewing…";
  if (role === "explore" || role === "explorer" || role === "scout") {
    return "Exploring…";
  }
  if (role === "research") return "Researching…";
  if (role === "build" || role === "builder" || role === "implementer") {
    return "Building…";
  }
  if (role === "debugger") return "Debugging…";
  return "Working…";
}
