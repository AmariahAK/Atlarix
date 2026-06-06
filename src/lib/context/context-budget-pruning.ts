/**
 * Rule-based synchronous pruning of context sections when dispatch estimate is high.
 * Never touches activeSkill or other protected sections (caller must skip or filter protected names).
 */

import { truncateToTokens } from "@/lib/truncate";
import type { ContextSection, ContextSectionName } from "@/lib/context/ContextAssembler";
import type { ContextBudgetHealth } from "@/lib/context/context-budget-tracker";

const PROTECTED_NAMES = new Set<ContextSectionName>(["activeSkill", "repoSkills"]);

/** Keep last K numbered exchanges in Session Context block (formatted by SessionMemory). */
function trimSessionMemoryContent(content: string, maxExchanges: number): string {
  const k = Math.max(1, Math.floor(maxExchanges));
  const convMarker = "**Recent Conversation:**";
  const errMarker = "**Recent Errors:**";
  const i0 = content.indexOf(convMarker);
  if (i0 < 0) return content;

  const iErr = content.indexOf(errMarker, i0);
  const head = content.slice(0, i0 + convMarker.length);
  const convBody =
    iErr >= 0 ? content.slice(i0 + convMarker.length, iErr) : content.slice(i0 + convMarker.length);
  const after = iErr >= 0 ? content.slice(iErr) : "";

  const lines = convBody.split("\n");
  const exchanges: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (/^\s*\d+\.\s+User:/.test(line)) {
      if (cur.length) exchanges.push(cur);
      cur = [line];
    } else if (cur.length) {
      cur.push(line);
    }
  }
  if (cur.length) exchanges.push(cur);

  const kept = exchanges.length > k ? exchanges.slice(-k) : exchanges;
  const newBody = kept
    .map((exLines, idx) => {
      const first = exLines[0] ?? "";
      const rest = exLines.slice(1);
      const renum = first.replace(/^\s*\d+\./, `${idx + 1}.`);
      return [renum, ...rest].join("\n");
    })
    .join("\n");

  return `${head}\n${newBody}${after ? `\n${after}` : ""}`;
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

  const sessionExchanges =
    health === "warning" ? 5 : health === "critical" ? 3 : health === "over" ? 2 : 10;

  return sections
    .map((section) => {
      if (PROTECTED_NAMES.has(section.name)) {
        return { ...section };
      }

      if (health === "over" && section.name === "parallelPrefetch") {
        return { ...section, content: "" };
      }

      if (section.name === "sessionMemory" && section.content.trim()) {
        return {
          ...section,
          content: trimSessionMemoryContent(section.content, sessionExchanges),
        };
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
