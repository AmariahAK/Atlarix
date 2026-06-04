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

