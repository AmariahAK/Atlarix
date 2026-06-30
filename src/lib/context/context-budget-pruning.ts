/**
 * Rule-based synchronous pruning of context sections when dispatch estimate is high.
 * Never touches activeSkill or other protected sections (caller must skip or filter protected names).
 */

import { truncateToTokens } from "@/lib/truncate";
import type { ContextSection, ContextSectionName } from "@/lib/context/ContextAssembler";
import type { ContextBudgetHealth } from "@/lib/context/context-budget-tracker";

const PROTECTED_NAMES = new Set<ContextSectionName>(["activeSkill", "repoSkills"]);

function firstParagraph(text: string): string {
  const t = text.trim();
  const parts = t.split(/\n\n+/);
  return parts[0]?.trim() ?? t;
}

/**
 * Apply pruning rules for a given health band. Idempotent for `healthy` (returns shallow copy).
 */
export function pruneContextSectionsForBudget(
  sections: ContextSection[],
  health: ContextBudgetHealth,
): ContextSection[] {
  if (health === "healthy") {
    return sections.map((s) => ({ ...s }));
  }

  return sections
    .map((section) => {
      if (PROTECTED_NAMES.has(section.name)) {
        return { ...section };
      }

      if (health === "over" && section.name === "parallelPrefetch") {
        return { ...section, content: "" };
      }

      if (section.name === "contextSummary" && section.content.trim()) {
        if (health === "over") {
          return { ...section, content: "" };
        }
        if (health === "critical") {
          return { ...section, content: truncateToTokens(section.content, 500) };
        }
        return { ...section };
      }

      if (section.name === "projectMemory" && section.content.trim()) {
        if (health === "over") {
          return { ...section, content: "" };
        }
        if (health === "critical") {
          return { ...section, content: firstParagraph(section.content) };
        }
      return { ...section };
    }

    return { ...section };
    })
    .filter((s) => s.content.trim().length > 0 || PROTECTED_NAMES.has(s.name));
}
