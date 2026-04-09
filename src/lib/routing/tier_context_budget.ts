import type { ModelMessage } from "ai";
import type { LargeLanguageModel, UserSettings } from "../schemas";
import type { ModelTier } from "./capability-registry";
import { summarizeMessagesWithCompactionPrompt } from "../context-compaction";
import { estimateTokens } from "../../ipc/utils/token_utils";
import { getTierContextLimits } from "./tier-context-limits";
import { resolveTierLimitModelIds } from "./context_budget_routing";

export interface BudgetHistoryMessage {
  role: string;
  content?: string;
  sourceCommitHash?: string;
  commitHash?: string;
}

export interface EnforceTierContextBudgetParams {
  resolvedTier: ModelTier;
  settings: UserSettings;
  effectiveModel: LargeLanguageModel;
  userPrompt: string;
  systemPrompt: string;
  /** Exact text from ContextAssembler merged as `\n\n${blob}`; empty if none */
  contextAssemblerBlob: string;
  limitedMessageHistory: BudgetHistoryMessage[];
  codebasePrefixMessages: readonly ModelMessage[];
  otherCodebasePrefixMessages: readonly ModelMessage[];
}

export interface EnforceTierContextBudgetResult {
  systemPrompt: string;
  limitedMessageHistory: BudgetHistoryMessage[];
  contextAssemblerBlob: string;
}

function totalPrefixTokens(prefixes: readonly ModelMessage[]): number {
  return prefixes.reduce((acc, m) => acc + estimateTokens(String(m.content ?? "")), 0);
}

function estimateDispatchTokens(params: {
  systemPrompt: string;
  history: BudgetHistoryMessage[];
  codebasePrefixMessages: readonly ModelMessage[];
  otherCodebasePrefixMessages: readonly ModelMessage[];
}): number {
  const msgTok = params.history.reduce(
    (acc, m) => acc + estimateTokens(m.content ?? ""),
    0,
  );
  return (
    estimateTokens(params.systemPrompt) +
    msgTok +
    totalPrefixTokens(params.codebasePrefixMessages) +
    totalPrefixTokens(params.otherCodebasePrefixMessages)
  );
}

type Entry = { i: number; role: string; content: string };

function nonSystemEntries(history: BudgetHistoryMessage[]): Entry[] {
  return history
    .map((m, i) => ({
      i,
      role: m.role,
      content: m.content ?? "",
    }))
    .filter((m) => m.role === "user" || m.role === "assistant");
}

/** First index in `entries` that starts the protected suffix (last 3 exchanges). */
function protectedEntryStartIndex(entries: Entry[]): number {
  if (entries.length === 0) return 0;
  let e = entries.length - 1;
  let exchanges = 0;
  while (exchanges < 3 && e >= 0) {
    if (entries[e].role === "assistant") {
      e--;
    }
    if (e < 0) break;
    if (entries[e].role === "user") {
      exchanges++;
      e--;
    } else {
      break;
    }
  }
  return Math.max(0, e + 1);
}

function replaceContextAssemblerBlob(
  systemPrompt: string,
  previousBlob: string,
  newBlob: string,
): string {
  if (!previousBlob) return systemPrompt;
  const needle = `\n\n${previousBlob}`;
  const i = systemPrompt.indexOf(needle);
  if (i < 0) return systemPrompt;
  return (
    systemPrompt.slice(0, i) +
    (newBlob.trim() ? `\n\n${newBlob}` : "") +
    systemPrompt.slice(i + needle.length)
  );
}

function trimContextAssemblerBlobOneStep(blob: string, userPrompt: string): string | null {
  const t = blob.trim();
  if (t.length < 80) return null;

  const lines = t.split("\n");
  const hintedLine = (line: string) => {
    const base = line.split(/[/\\]/).pop() ?? line;
    if (base.length < 3) return false;
    return userPrompt.includes(base);
  };

  const preferWorkspaceAndHints = lines.filter(
    (line) =>
      hintedLine(line) ||
      line.includes("[WORKSPACE:") ||
      line.startsWith("#") ||
      line.startsWith("##"),
  );
  if (preferWorkspaceAndHints.length > 0) {
    const compact = preferWorkspaceAndHints.join("\n").trim();
    if (compact.length > 0 && compact.length < t.length) {
      return compact;
    }
  }

  const withoutCompactLines = lines
    .filter((line) => !/^Key:\s*/.test(line))
    .filter((line) => !/^Structure:\s*/.test(line))
    .filter((line) => !/^Entry:\s*/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (withoutCompactLines.length > 0 && withoutCompactLines.length < t.length) {
    return withoutCompactLines;
  }

  const lastH2 = t.lastIndexOf("\n## ");
  if (lastH2 > 200) {
    return t.slice(0, lastH2).trim();
  }

  const half = Math.floor(t.length * 0.55);
  if (half < 400) {
    return t.slice(0, 400).trim();
  }
  return t.slice(0, half).trim();
}

/**
 * Pre-dispatch tier budgeting for balanced/thinking. Fast tier: no-op.
 */
export async function enforceTierContextBudget(
  params: EnforceTierContextBudgetParams,
): Promise<EnforceTierContextBudgetResult> {
  const {
    resolvedTier,
    settings,
    codebasePrefixMessages,
    otherCodebasePrefixMessages,
  } = params;

  if (resolvedTier === "fast") {
    return {
      systemPrompt: params.systemPrompt,
      limitedMessageHistory: params.limitedMessageHistory,
      contextAssemblerBlob: params.contextAssemblerBlob,
    };
  }

  let systemPrompt = params.systemPrompt;
  let limitedMessageHistory = params.limitedMessageHistory;
  let contextAssemblerBlob = params.contextAssemblerBlob;

  const ids = resolveTierLimitModelIds(settings, {
    effectiveModel: params.effectiveModel,
    resolvedTier: params.resolvedTier,
  });
  const limits = await getTierContextLimits(ids.fast, ids.balanced, ids.thinking);
  const tierLimit = limits[resolvedTier];

  const countToolsInMessages = (msgs: BudgetHistoryMessage[]) =>
    msgs.filter(
      (m) =>
        (m.content ?? "").includes("tool_result") ||
        (m.content ?? "").includes("tool_use"),
    ).length;

  let overBudget = () =>
    estimateDispatchTokens({
      systemPrompt,
      history: limitedMessageHistory,
      codebasePrefixMessages,
      otherCodebasePrefixMessages,
    }) > tierLimit;

  if (!overBudget()) {
    return { systemPrompt, limitedMessageHistory, contextAssemblerBlob };
  }

  const maxRounds = 24;
  for (let round = 0; round < maxRounds && overBudget(); round++) {
    const entries = nonSystemEntries(limitedMessageHistory);
    const pStart = protectedEntryStartIndex(entries);
    const firstProtectedOriginalIndex =
      pStart < entries.length ? entries[pStart].i : limitedMessageHistory.length;

    const head = limitedMessageHistory.slice(0, firstProtectedOriginalIndex);
    const tail = limitedMessageHistory.slice(firstProtectedOriginalIndex);
    const headConversation = head.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );

    let compressed = false;
    if (headConversation.length >= 2) {
      const toolCallCount = countToolsInMessages(limitedMessageHistory);
      const delegationCount = limitedMessageHistory.filter(
        (m) =>
          (m.content ?? "").includes("delegate_to_agent") ||
          (m.content ?? "").includes("delegation"),
      ).length;
      const summary = await summarizeMessagesWithCompactionPrompt({
        messages: headConversation.map((m) => ({
          role: m.role,
          content: m.content ?? "",
        })),
        sessionStats: { toolCallCount, delegationCount },
      });
      if (summary) {
        const headSystemOnly = head.filter((m) => m.role === "system");
        const summaryMsg: BudgetHistoryMessage = {
          role: "user",
          content:
            "[Earlier conversation — compressed for context budget]\n" + summary,
        };
        limitedMessageHistory = [...headSystemOnly, summaryMsg, ...tail];
        compressed = true;
      }
    }

    if (!compressed && headConversation.length > 0) {
      limitedMessageHistory = [
        ...head.filter((m) => m.role === "system"),
        ...headConversation.slice(2),
        ...tail,
      ];
    }

    if (!overBudget()) break;

    if (contextAssemblerBlob.trim()) {
      const prev = contextAssemblerBlob;
      const trimmed = trimContextAssemblerBlobOneStep(
        contextAssemblerBlob,
        params.userPrompt,
      );
      if (trimmed != null && trimmed !== prev) {
        systemPrompt = replaceContextAssemblerBlob(systemPrompt, prev, trimmed);
        contextAssemblerBlob = trimmed;
      }
    }

    if (!overBudget()) break;

    if (!compressed && headConversation.length === 0) {
      break;
    }
  }

  return { systemPrompt, limitedMessageHistory, contextAssemblerBlob };
}
