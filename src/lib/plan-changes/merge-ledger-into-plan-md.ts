import type { PlanUpdatePayload } from "@/ipc/ipc_types";

function checkboxFromStatus(status: string): string {
  switch (status) {
    case "done":
      return "x";
    case "in_progress":
      return "~";
    case "failed":
      return "!";
    default:
      return " ";
  }
}

/** Overlay live ledger step status onto numbered checkbox lines in ATLARIX_PLAN.md. */
export function mergeLedgerIntoPlanMarkdown(
  markdown: string,
  ledger: PlanUpdatePayload | null,
): string {
  if (!ledger?.steps.length) return markdown;
  return markdown
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*)(\d+)\.\s+\[[ x~!]\]\s*(.+)$/i);
      if (!m) return line;
      const idx = parseInt(m[2]!, 10) - 1;
      const step = ledger.steps[idx];
      if (!step) return line;
      const mark = checkboxFromStatus(step.status);
      return `${m[1]}${m[2]}. [${mark}] ${step.description}`;
    })
    .join("\n");
}
