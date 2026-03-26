import { createHash } from "node:crypto";
import { estimateTokens } from "@/ipc/utils/token_utils";
import type { WorkMode } from "@/lib/schemas";
import { getContextAssemblyCache, setContextAssemblyCache } from "./context-assembly-cache";

export type ContextSectionName =
  | "workModeHint"
  | "blueprint"
  | "workspaceAnalysis"
  | "projectMemory"
  | "contextSummary"
  | "sessionMemory";

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
  if (cached) return { ...cached, cache: { key: cacheKey, hit: true } };

  let remaining = modeCap;
  const trimReport: string[] = [];
  const assembledPromptSections: ContextAssemblerOutput["assembledPromptSections"] = [];
  const tokenUsageBySection: Record<string, number> = {};
  const includedBlocks: string[] = [];

  for (const section of normalizedSections) {
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
