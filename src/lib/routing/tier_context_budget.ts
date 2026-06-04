import type { ModelMessage } from "ai";
import type { LargeLanguageModel, UserSettings } from "../schemas";
import type { ModelTier } from "./capability-registry";
import { summarizeMessagesWithCompactionPrompt } from "../context-compaction";
import { estimateTokens } from "../../ipc/utils/token_utils";
import { resolveModelContextLimit } from "../context/resolve-model-context-limit";

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
  /** True if summarizeMessagesWithCompactionPrompt ran at least once. */
  llmCompactionApplied?: boolean;
}

function totalPrefixTokens(prefixes: readonly ModelMessage[]): number {
  return prefixes.reduce((acc, m) => acc + estimateTokens(String(m.content ?? "")), 0);
}

export function estimateDispatchTokens(params: {
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
 * Pre-dispatch budgeting: model context limit (any tier), with LLM summarize only as last resort.
 */
export async function enforceTierContextBudget(
  params: EnforceTierContextBudgetParams,
): Promise<EnforceTierContextBudgetResult> {
  const { settings, codebasePrefixMessages, otherCodebasePrefixMessages } = params;

  let systemPrompt = params.systemPrompt;
  let limitedMessageHistory = params.limitedMessageHistory;
  let contextAssemblerBlob = params.contextAssemblerBlob;

  const { tierLimit } = await resolveModelContextLimit(
    params.effectiveModel,
    settings,
  );
  let llmCompactionApplied = false;

  const countToolsInMessages = (msgs: BudgetHistoryMessage[]) =>
    msgs.filter(
      (m) =>
        (m.content ?? "").includes("tool_result") ||
        (m.content ?? "").includes("tool_use"),
    ).length;

  const currentEstimate = () =>
    estimateDispatchTokens({
      systemPrompt,
      history: limitedMessageHistory,
      codebasePrefixMessages,
      otherCodebasePrefixMessages,
    });

  let overBudget = () => currentEstimate() > tierLimit;

  if (!overBudget()) {
    return { systemPrompt, limitedMessageHistory, contextAssemblerBlob };
  }

  const softCap = tierLimit * 0.85;
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

    if (headConversation.length > 0) {
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

    const entriesAfterTrim = nonSystemEntries(limitedMessageHistory);
    const pStart2 = protectedEntryStartIndex(entriesAfterTrim);
    const firstProtected2 =
      pStart2 < entriesAfterTrim.length
        ? entriesAfterTrim[pStart2].i
        : limitedMessageHistory.length;
    const head2 = limitedMessageHistory.slice(0, firstProtected2);
    const tail2 = limitedMessageHistory.slice(firstProtected2);
    const headConversation2 = head2.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );

    if (
      headConversation2.length >= 2 &&
      currentEstimate() >= softCap &&
      overBudget()
    ) {
      const toolCallCount = countToolsInMessages(limitedMessageHistory);
      const delegationCount = limitedMessageHistory.filter(
        (m) =>
          (m.content ?? "").includes("delegate_to_agent") ||
          (m.content ?? "").includes("delegation"),
      ).length;
      const summary = await summarizeMessagesWithCompactionPrompt({
        messages: headConversation2.map((m) => ({
          role: m.role,
          content: m.content ?? "",
        })),
        sessionStats: { toolCallCount, delegationCount },
      });
      if (summary) {
        llmCompactionApplied = true;
        const headSystemOnly = head2.filter((m) => m.role === "system");
        const summaryMsg: BudgetHistoryMessage = {
          role: "user",
          content:
            "[Earlier conversation — compressed for context budget]\n" + summary,
        };
        limitedMessageHistory = [...headSystemOnly, summaryMsg, ...tail2];
      }
    }

    if (!overBudget()) break;

    if (headConversation.length === 0) {
      break;
    }
  }

  return {
    systemPrompt,
    limitedMessageHistory,
    contextAssemblerBlob,
    llmCompactionApplied,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MID-TURN AGENTIC-LOOP COMPACTION
// ════════════════════════════════════════════════════════════════════════════

/** Extract the text portion of a ModelMessage's content for estimation/summary. */
function modelMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as { type?: string; text?: string; output?: unknown; result?: unknown };
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "tool-result") {
          const v = p.output ?? p.result;
          return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export interface MidLoopCompactionParams {
  /** Mutable list of agentic-loop messages (ModelMessage shape; we only require role + content). */
  messages: ModelMessage[];
  /** Estimated tokens used by the system prompt + any prefix messages we cannot trim here. */
  systemPromptEstimate: number;
  /** Effective per-dispatch limit (from `resolveModelContextLimit`). */
  tierLimit: number;
  /** Catalog raw context length; when set, fill ratio uses this instead of `tierLimit`. */
  contextWindowTokens?: number;
  /** Trigger compaction when `(systemPromptEstimate + history) >= threshold * limitDenom`. */
  threshold?: number;
  /** Last N protected user+assistant exchanges (default 3 — matches `enforceTierContextBudget`). */
  protectExchanges?: number;
  /** Optional session stats forwarded to the compaction model. */
  sessionStats?: { toolCallCount?: number; delegationCount?: number };
  /** v10: when set, summarization tokens count toward this chat's turn usage. */
  chatId?: number;
}

export interface MidLoopCompactionResult {
  messages: ModelMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * In-loop compaction for the SMART AGENTIC TOOL LOOP. Estimates the token weight
 * of `agenticMessages` plus the system prompt; if it crosses `threshold` of the
 * model's context window (or `tierLimit` when `contextWindowTokens` is omitted),
 * replaces older user+assistant turns with a single summary
 * `protectExchanges` user+assistant exchanges (= most recent tool result) are
 * always preserved verbatim so the model can keep reasoning.
 *
 * If compaction is unnecessary or the summarizer call fails, the messages are
 * returned unchanged (`compacted: false`).
 */
export async function compactAgenticMessagesIfNeeded(
  params: MidLoopCompactionParams,
): Promise<MidLoopCompactionResult> {
  const threshold = params.threshold ?? 0.75;
  const protect = params.protectExchanges ?? 3;
  const limitDenom = params.contextWindowTokens ?? params.tierLimit;

  const tokensOf = (m: ModelMessage) => estimateTokens(modelMessageText(m.content));
  const total = (msgs: ModelMessage[]) =>
    msgs.reduce((acc, m) => acc + tokensOf(m), 0) + params.systemPromptEstimate;

  const beforeTokens = total(params.messages);
  if (beforeTokens < threshold * limitDenom) {
    return { messages: params.messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
  }

  // Locate the protected suffix: walk back from the tail collecting `protect`
  // assistant->user pairs of user+assistant exchanges (mirrors the
  // `protectedEntryStartIndex` heuristic in this file).
  const entries = nonSystemEntries(
    params.messages.map((m) => ({ role: m.role, content: modelMessageText(m.content) })),
  );
  if (entries.length === 0) {
    return { messages: params.messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
  }
  let e = entries.length - 1;
  let exchanges = 0;
  while (exchanges < protect && e >= 0) {
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
  const firstProtectedOriginalIndex =
    e + 1 < entries.length ? entries[e + 1].i : params.messages.length;

  const head = params.messages.slice(0, firstProtectedOriginalIndex);
  const tail = params.messages.slice(firstProtectedOriginalIndex);
  const headConversation = head.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  // Without anything to summarize, just return as-is.
  if (headConversation.length === 0) {
    return { messages: params.messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
  }

  const summary = await summarizeMessagesWithCompactionPrompt({
    messages: headConversation.map((m) => ({
      role: m.role,
      content: modelMessageText(m.content),
    })),
    sessionStats: params.sessionStats,
    chatId: params.chatId,
  });
  if (!summary) {
    return { messages: params.messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
  }

  const summaryMsg: ModelMessage = {
    role: "user",
    content: "[Earlier in-task conversation — compressed for context budget]\n" + summary,
  };
  const headSystem = head.filter((m) => m.role === "system");
  const newMessages = [...headSystem, summaryMsg, ...tail];
  const afterTokens = total(newMessages);
  return {
    messages: newMessages,
    compacted: true,
    beforeTokens,
    afterTokens,
  };
}
