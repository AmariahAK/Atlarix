/**
 * Build classifier input for Auto routing: sliding history window + task state blob.
 */

import type { ModelTier } from "./capability-registry";

export const GROQ_CLASSIFIER_MAX_CHARS = 12_000;
export const FAST_CLASSIFIER_MAX_CHARS = 5_500;
export const ROUTING_HISTORY_MAX_CHARS = 5_500;
export const ROUTING_HISTORY_MAX_PAIRS = 3;

export interface RoutingMessage {
  role: string;
  content: string;
}

export interface AutoRouterTaskState {
  currentMode: string;
  workModePreference: string;
  agentMode: string;
  hasActivePlan: boolean;
  lastTier: ModelTier | null;
  messageIndex: number;
  recentAssistantTiers: ModelTier[];
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.55);
  const tail = max - head - 3;
  return `${s.slice(0, head)}...${s.slice(s.length - tail)}`;
}

/**
 * Prior messages only: drop current user turn and in-flight empty assistant (if present).
 */
export function sliceMessagesBeforeCurrentTurn(messages: RoutingMessage[]): RoutingMessage[] {
  const m = [...messages];
  if (
    m.length >= 1 &&
    m[m.length - 1]?.role === "assistant" &&
    !String(m[m.length - 1]?.content ?? "").trim()
  ) {
    m.pop();
  }
  if (m.length >= 1 && m[m.length - 1]?.role === "user") {
    m.pop();
  }
  return m;
}

/**
 * Last N assistant auto_routed tiers, newest first (same order as DB desc id).
 */
export function getRecentAssistantRoutingTiers(
  messages: Array<{ role?: string; autoRoutedTier?: ModelTier | null | undefined }>,
  limit = 3,
): ModelTier[] {
  const out: ModelTier[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const row = messages[i];
    if (row?.role === "assistant" && row.autoRoutedTier) {
      out.push(row.autoRoutedTier);
    }
  }
  return out;
}

export function formatRoutingHistoryWindow(
  messagesBeforeCurrent: RoutingMessage[],
  opts?: { maxPairs?: number; maxChars?: number },
): string {
  const maxPairs = opts?.maxPairs ?? ROUTING_HISTORY_MAX_PAIRS;
  const maxChars = opts?.maxChars ?? ROUTING_HISTORY_MAX_CHARS;
  const m = messagesBeforeCurrent;
  const blocks: string[] = [];
  let i = m.length - 1;
  let pairs = 0;
  while (i >= 1 && pairs < maxPairs) {
    const asst = m[i];
    const usr = m[i - 1];
    if (asst?.role === "assistant" && usr?.role === "user" && String(asst.content ?? "").trim()) {
      const u = truncateMiddle(String(usr.content ?? "").trim(), 3_500);
      const a = truncateMiddle(String(asst.content ?? "").trim(), 3_500);
      blocks.unshift(`User:\n${u}\n\nAssistant:\n${a}`);
      pairs++;
      i -= 2;
    } else {
      i--;
    }
  }
  let text = blocks.join("\n\n---\n\n");
  while (text.length > maxChars && blocks.length > 1) {
    blocks.shift();
    text = blocks.join("\n\n---\n\n");
  }
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
  }
  return text.trim();
}

export function formatTaskStateBlock(state: AutoRouterTaskState): string {
  const recent = state.recentAssistantTiers.length
    ? state.recentAssistantTiers.join(", ")
    : "(none)";
  return [
    `currentMode: ${state.currentMode}`,
    `workModePreference: ${state.workModePreference}`,
    `agentMode: ${state.agentMode}`,
    `hasActivePlan: ${state.hasActivePlan}`,
    `lastTier: ${state.lastTier ?? "null"}`,
    `messageIndex: ${state.messageIndex}`,
    `recentAssistantAutoTiersNewestFirst: [${recent}]`,
  ].join("\n");
}

export function buildClassifierUserText(args: {
  taskState: AutoRouterTaskState;
  historyWindow: string;
  currentPrompt: string;
  maxTotalChars: number;
}): string {
  const task = formatTaskStateBlock(args.taskState);
  const cur = args.currentPrompt.trim();
  const headerTask = "## Task state\n";
  const headerHist = "\n\n## Recent conversation (prior turns)\n";
  const headerCur = "\n\n## Current message (classify this turn)\n";
  let hist = args.historyWindow.trim();
  let budget = args.maxTotalChars - headerTask.length - task.length - headerHist.length - headerCur.length - cur.length - 8;
  if (budget < 0) budget = 0;
  if (hist.length > budget) {
    hist = hist.slice(hist.length - budget);
  }
  return `${headerTask}${task}${headerHist}${hist || "(no prior turns)"}${headerCur}${truncateMiddle(cur, Math.min(8000, args.maxTotalChars / 2))}`;
}
