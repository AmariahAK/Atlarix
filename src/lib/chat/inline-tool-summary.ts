import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";

export function summarizeInlineTool(part: Extract<AssistantMessagePart, { type: "tool" }>): string {
  const name = part.toolName;
  const args = part.args as Record<string, unknown> | undefined;
  const detail =
    part.resultText?.trim() ||
    (typeof args?.path === "string" ? args.path : "") ||
    (typeof args?.query === "string" ? args.query : "") ||
    (typeof args?.command === "string" ? args.command : "") ||
    "";

  if (name === "read_file" && detail) {
    return `Read ${detail.slice(0, 80)}`;
  }
  if (
    (name === "write_file" || name === "edit_file" || name === "search_replace") &&
    detail
  ) {
    return `Modified ${detail.split(/\s/)[0]?.slice(0, 80) ?? detail.slice(0, 80)}`;
  }
  if (
    name === "search_code" ||
    name === "search" ||
    name === "grep"
  ) {
    return detail ? `Grepped for ${detail.slice(0, 72)}` : "Ran codebase search";
  }
  if (name === "run_command" || name === "execute_command") {
    return detail ? `Ran \`${detail.slice(0, 60)}\`` : "Ran terminal command";
  }
  if (name === "write_implementation_plan") {
    return "Plan saved";
  }
  if (name === "explore_folder" || name === "list_files") {
    return detail ? `Explored ${detail.slice(0, 72)}` : "Explored files";
  }

  const base = getToolActivityLabel(name).replace(/…$/u, "");
  return detail ? `${base}: ${detail.slice(0, 80)}` : base;
}
