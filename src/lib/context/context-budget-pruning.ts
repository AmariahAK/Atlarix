/**
 * Rule-based synchronous pruning of context sections when dispatch estimate is high.
 * Never touches activeSkill or other protected sections (caller must skip or filter protected names).
 */

import { truncateToTokens } from "@/lib/truncate";
import type {
  ContextSection,
  ContextSectionName,
} from "@/lib/context/ContextAssembler";
import type { ContextBudgetHealth } from "@/lib/context/context-budget-tracker";

/**
 * Never pruned.
 *
 * `skillsIndex` joins the list because it is now a handful of one-line pointers
 * rather than skill bodies — dropping it would hide from the model that a skill
 * exists at all, which is the one thing the index is for. (Before v14.25.0 the
 * body-injecting `installedSkills` section had NO rule here at all, so ~24 KB of
 * skill text outranked `projectMemory` and `contextSummary` under pressure.)
 */
const PROTECTED_NAMES = new Set<ContextSectionName>([
  "activeSkill",
  "skillsIndex",
]);

/**
 * Human-readable notes describing what the pruner actually did.
 *
 * The pruner mutates section CONTENT in place of the assembler's budget logic,
 * which is inert (`remaining = Infinity`, no caller can pass a budget) — so
 * `ContextAssembler.trimReport` is always empty and the meter's "Pruned at last
 * dispatch" panel had nothing to render. Silent pruning is the same class of bug
 * as silent truncation: diff before/after and say so.
 */
export function describeBudgetPruning(
  before: ContextSection[],
  after: ContextSection[],
): string[] {
  const afterByName = new Map(after.map((s) => [s.name, s]));
  const notes: string[] = [];
  for (const prev of before) {
    const next = afterByName.get(prev.name);
    const prevLen = prev.content.trim().length;
    if (prevLen === 0) continue;
    if (!next || next.content.trim().length === 0) {
      notes.push(`Dropped ${prev.name} (context budget)`);
      continue;
    }
    if (next.content.length < prev.content.length) {
      const pct = Math.round((next.content.length / prev.content.length) * 100);
      notes.push(`Trimmed ${prev.name} to ~${pct}% (context budget)`);
    }
  }
  return notes;
}

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
          return {
            ...section,
            content: truncateToTokens(section.content, 500),
          };
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
