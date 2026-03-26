/**
 * v5.1 Section 5: Map UI work modes to default specialist agents and short system hints.
 */

import type { WorkMode } from "@/lib/schemas";
import type { BuiltinAgentId } from "./builtin";

/** Preferred delegate_to_agent target for each work mode. */
export function defaultAgentForWorkMode(mode: WorkMode): BuiltinAgentId {
  switch (mode) {
    case "ask":
      return "research";
    case "plan":
      return "architect";
    case "build":
      return "builder";
    case "debug":
      return "debugger";
    case "review":
      return "reviewer";
  }
}

/** One-paragraph hint appended to the main system prompt when not in Auto. */
export function workModeSystemHint(mode: WorkMode): string {
  const lines: Record<WorkMode, string> = {
    ask: "Prefer read-only exploration and clear explanations. When delegating, prefer the **Research** specialist.",
    plan: "Blueprint-first: clarify structure before edits; favor **Architect**-style outputs and ATLARIX_PLAN when appropriate.",
    build: "Implementation focus: **Builder**-style small, testable changes.",
    debug: "Root-cause and trace analysis; prefer the **Debugger** specialist for structured diagnosis.",
    review: "Quality, security, and diff-aware review; prefer the **Reviewer** specialist.",
  };
  return lines[mode];
}
