import { createHash } from "node:crypto";
import { estimateTokens } from "@/ipc/utils/token_utils";
import type { WorkMode } from "@/lib/schemas";
import { getContextAssemblyCache, setContextAssemblyCache } from "./context-assembly-cache";

export type ContextSectionName =
  | "activeSkill"
  | "taskProgress"
  | "fileSystemTruth"
  | "workModeHint"
  | "blueprint"
  | "workspaceAnalysis"
  | "projectMemory"
  | "contextSummary"
  | "sessionMemory"
  | "counsel"
  | "counselDeepThinkSubstitute"
  | "parallelPrefetch";

export type ContextSection = {
  name: ContextSectionName;
  priority: number;
  content: string;
};

export type ContextAssemblerInput = {
  chatId: number;
  appId?: number | null;
  workMode: WorkMode;
  userPrompt: string;
  sections: ContextSection[];
};

export type ContextAssemblerOutput = {
  /** Active mode/agent skill markdown — protected from mode-cap trim (re-injected each assembly). */
  activeSkillAddition: string;
  /** Task ledger / progress — not counted against mode cap; keep out of tier blob trim. */
  taskProgressAddition: string;
  /** On-disk excerpts for last completed ledger step — protected like task progress (not in tier-trimmed blob). */
  fileSystemTruthAddition: string;
  finalSystemPromptAddition: string;
  assembledPromptSections: Array<ContextSection & { tokens: number; included: boolean; truncated: boolean }>;
  tokenUsageBySection: Record<string, number>;
  trimReport: string[];
  cache: { key: string; hit: boolean };
  modeCap: number;
};

const MODE_CONTEXT_CAPS: Record<WorkMode, number> = {
  ask: 1500,
  plan: 3000,
  build: 5000,
  debug: 3500,
  review: 2000,
};

/** Hard safety ceiling only; normal task progress should stay well under this. */
const ACTIVE_SKILL_TOKEN_CEILING = 8000;
const TASK_PROGRESS_TOKEN_CEILING = 6000;
const FILESYSTEM_TRUTH_TOKEN_CEILING = 8000;

function truncateToTokens(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content;
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const slice = content.slice(0, mid);
    if (estimateTokens(slice) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return `${content.slice(0, Math.max(0, lo))}\n\n...(trimmed to fit context cap)`;
}

export function assembleContextSections(input: ContextAssemblerInput): ContextAssemblerOutput {
  const modeCap = MODE_CONTEXT_CAPS[input.workMode];
  const normalizedSections = [...input.sections]
    .filter((s) => s.content.trim().length > 0)
    .sort((a, b) => a.priority - b.priority);

  const activeSkillSections = normalizedSections.filter((s) => s.name === "activeSkill");
  const taskProgressSections = normalizedSections.filter((s) => s.name === "taskProgress");
  const fileSystemTruthSections = normalizedSections.filter((s) => s.name === "fileSystemTruth");
  const otherSections = normalizedSections.filter(
    (s) =>
      s.name !== "activeSkill" &&
      s.name !== "taskProgress" &&
      s.name !== "fileSystemTruth",
  );

  let activeSkillAddition = activeSkillSections.map((s) => s.content.trim()).join("\n\n");
  if (activeSkillAddition && estimateTokens(activeSkillAddition) > ACTIVE_SKILL_TOKEN_CEILING) {
    activeSkillAddition = truncateToTokens(activeSkillAddition, ACTIVE_SKILL_TOKEN_CEILING);
  }

  let taskProgressAddition = taskProgressSections.map((s) => s.content.trim()).join("\n\n");
  if (taskProgressAddition && estimateTokens(taskProgressAddition) > TASK_PROGRESS_TOKEN_CEILING) {
    taskProgressAddition = truncateToTokens(taskProgressAddition, TASK_PROGRESS_TOKEN_CEILING);
  }

  let fileSystemTruthAddition = fileSystemTruthSections.map((s) => s.content.trim()).join("\n\n");
  if (
    fileSystemTruthAddition &&
    estimateTokens(fileSystemTruthAddition) > FILESYSTEM_TRUTH_TOKEN_CEILING
  ) {
    fileSystemTruthAddition = truncateToTokens(
      fileSystemTruthAddition,
      FILESYSTEM_TRUTH_TOKEN_CEILING,
    );
  }

  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify({
        chatId: input.chatId,
        appId: input.appId ?? null,
        workMode: input.workMode,
        userPrompt: input.userPrompt,
        sections: normalizedSections.map((s) => ({ name: s.name, content: s.content })),
      }),
    )
    .digest("hex");

  const cached = getContextAssemblyCache<ContextAssemblerOutput>(cacheKey);
  if (cached) {
    return {
      ...cached,
      activeSkillAddition: cached.activeSkillAddition ?? "",
      taskProgressAddition: cached.taskProgressAddition ?? "",
      fileSystemTruthAddition: cached.fileSystemTruthAddition ?? "",
      cache: { key: cacheKey, hit: true },
    };
  }

  let remaining = modeCap;
  const trimReport: string[] = [];
  const assembledPromptSections: ContextAssemblerOutput["assembledPromptSections"] = [];
  const tokenUsageBySection: Record<string, number> = {};
  const includedBlocks: string[] = [];

  for (const section of activeSkillSections) {
    const sectionTokens = estimateTokens(section.content);
    tokenUsageBySection[section.name] = sectionTokens;
    assembledPromptSections.push({
      ...section,
      tokens: sectionTokens,
      included: true,
      truncated: estimateTokens(activeSkillAddition) < sectionTokens,
    });
  }

  for (const section of taskProgressSections) {
    const sectionTokens = estimateTokens(section.content);
    tokenUsageBySection[section.name] = sectionTokens;
    assembledPromptSections.push({
      ...section,
      tokens: sectionTokens,
      included: true,
      truncated: estimateTokens(taskProgressAddition) < sectionTokens,
    });
  }

  for (const section of fileSystemTruthSections) {
    const sectionTokens = estimateTokens(section.content);
    tokenUsageBySection[section.name] = sectionTokens;
    assembledPromptSections.push({
      ...section,
      tokens: sectionTokens,
      included: true,
      truncated: estimateTokens(fileSystemTruthAddition) < sectionTokens,
    });
  }

  for (const section of otherSections) {
    const sectionTokens = estimateTokens(section.content);
    tokenUsageBySection[section.name] = sectionTokens;

    if (remaining <= 0) {
      assembledPromptSections.push({
        ...section,
        tokens: sectionTokens,
        included: false,
        truncated: false,
      });
      trimReport.push(`Skipped ${section.name} (no remaining tokens)`);
      continue;
    }

    if (sectionTokens <= remaining) {
      includedBlocks.push(section.content);
      remaining -= sectionTokens;
      assembledPromptSections.push({
        ...section,
        tokens: sectionTokens,
        included: true,
        truncated: false,
      });
      continue;
    }

    const truncated = truncateToTokens(section.content, remaining);
    const truncatedTokens = estimateTokens(truncated);
    if (truncatedTokens > 0) {
      includedBlocks.push(truncated);
      assembledPromptSections.push({
        ...section,
        tokens: truncatedTokens,
        included: true,
        truncated: true,
      });
      trimReport.push(`Trimmed ${section.name} from ${sectionTokens} to ${truncatedTokens} tokens`);
      remaining = Math.max(0, remaining - truncatedTokens);
    } else {
      assembledPromptSections.push({
        ...section,
        tokens: sectionTokens,
        included: false,
        truncated: false,
      });
      trimReport.push(`Skipped ${section.name} (insufficient token budget)`);
    }
  }

  const output: ContextAssemblerOutput = {
    activeSkillAddition,
    taskProgressAddition,
    fileSystemTruthAddition,
    finalSystemPromptAddition: includedBlocks.join("\n\n"),
    assembledPromptSections,
    tokenUsageBySection,
    trimReport,
    cache: { key: cacheKey, hit: false },
    modeCap,
  };

  setContextAssemblyCache(cacheKey, output);
  return output;
}
