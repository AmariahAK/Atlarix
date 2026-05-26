/**
 * v5.1 Section 5: Map UI work modes to default specialist agents and short system hints.
 */

import type { WorkMode } from "@/lib/schemas";
import type { DelegationAgentId } from "@/lib/skills/skill-registry";

/** Preferred delegate_to_agent target for each work mode. */
export function defaultAgentForWorkMode(mode: WorkMode): DelegationAgentId {
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
    ask: "Read-only exploration only; do not imply the user should switch to Build for normal Q&A. For plan files, steer to **Plan** mode. When delegating, prefer the **Research** specialist.",
    plan: "Plan-first: use session plan tools (`write_implementation_plan`) and `.atlarix/atlarix.md`; mention **Build** only after the plan is ready—not during clarification.",
    build: "Implementation focus: **Builder**-style small, testable changes.",
    debug: "Root-cause and trace analysis; prefer the **Debugger** specialist for structured diagnosis.",
    review: "Quality, security, and diff-aware review; prefer the **Reviewer** specialist.",
  };
  return lines[mode];
}
