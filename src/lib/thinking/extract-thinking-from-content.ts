import type { AgentBusExchange } from "@/atoms/sourceAtoms";
import { normalizeThinkingTags } from "@/lib/thinking/normalize-thinking-tags";

/** v10.1: moved here from the deleted dead ThinkingSection component. */
export interface ToolCallInfo {
  id: string;
  toolName: string;
  status: "success" | "error" | "running";
  args?: unknown;
  error?: string;
}

export type CompletedTurnThinkingSnapshot = {
  thoughts: string[];
  reasoningFromTags: string;
  modelReasoning: string;
  toolCalls: ToolCallInfo[];
  busExchanges: AgentBusExchange[];
};

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str ? { raw: str } : undefined;
  }
}

function preprocessUnclosedTags(content: string): string {
  const customTagNames = [
    "reasoning",
    "redacted_thinking",
    "atlarix-mcp-tool-call",
    "atlarix-mcp-tool-result",
    "atlarix-tool-call",
    "atlarix-tool-result",
  ];
  let processed = normalizeThinkingTags(content);

  for (const tagName of customTagNames) {
    const openTagPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
    const closeTagPattern = new RegExp(`</${tagName}>`, "g");
    const openCount = (processed.match(openTagPattern) || []).length;
    const closeCount = (processed.match(closeTagPattern) || []).length;
    const missing = openCount - closeCount;
    if (missing > 0) {
      processed += Array(missing).fill(`</${tagName}>`).join("");
    }
  }
  return processed;
}

function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/**
 * Extract thinking-card fields from assistant message content (including live stream tags).
 */
export function extractThinkingFromContent(
  content: string,
  options?: { isStreaming?: boolean; busExchanges?: AgentBusExchange[] },
): CompletedTurnThinkingSnapshot {
  const processed = preprocessUnclosedTags(content);
  const tagNames = [
    "atlarix-mcp-tool-call",
    "atlarix-mcp-tool-result",
    "atlarix-tool-call",
    "atlarix-tool-result",
    "redacted_thinking",
    "reasoning",
  ];
  const tagPattern = new RegExp(
    `<(${tagNames.join("|")})\\s*([^>]*)>(.*?)<\\/\\1>`,
    "gs",
  );

  const thoughts: string[] = [];
  const reasoningParts: string[] = [];
  const modelReasoningParts: string[] = [];
  const toolMap = new Map<string, ToolCallInfo & { seqIndex: number }>();
  const toolNameCounts: Record<string, number> = {};
  const isStreaming = options?.isStreaming ?? false;

  for (const match of processed.matchAll(tagPattern)) {
    const [, tag, attributesStr, tagContent] = match;
    const attrs = parseAttributes(attributesStr ?? "");
    const trimmed = tagContent?.trim() ?? "";

    if (tag === "reasoning") {
      if (trimmed) reasoningParts.push(trimmed);
    } else if (tag === "redacted_thinking") {
      if (trimmed) modelReasoningParts.push(trimmed);
    } else if (
      tag === "atlarix-tool-call" ||
      tag === "atlarix-tool-result" ||
      tag === "atlarix-mcp-tool-call" ||
      tag === "atlarix-mcp-tool-result"
    ) {
      const toolName = attrs.tool || attrs.name || attrs.server || "";
      const isInProgress = false;
      let status: ToolCallInfo["status"] = "success";
      if (attrs.status === "error") status = "error";
      else if (attrs.status === "running" || isInProgress) {
        status = !isStreaming && isInProgress ? "error" : "running";
      }

      const seqNum = toolNameCounts[toolName] || 0;
      const mapKey = `${toolName}_${seqNum}`;
      if (tag.includes("tool-call") && !toolMap.has(mapKey)) {
        toolNameCounts[toolName] = seqNum + 1;
      }

      let targetKey = mapKey;
      if (tag.includes("tool-result")) {
        for (let i = seqNum; i >= 0; i--) {
          const checkKey = `${toolName}_${i}`;
          const existing = toolMap.get(checkKey);
          if (existing?.status === "running") {
            targetKey = checkKey;
            break;
          }
        }
      }

      const existing = toolMap.get(targetKey);
      if (existing) {
        if (existing.status === "running" && status !== "running") {
          toolMap.set(targetKey, {
            ...existing,
            status,
            error: attrs.error,
          });
        }
      } else if (tag.includes("tool-call") || tag.includes("tool-result")) {
        toolMap.set(targetKey, {
          id: targetKey,
          toolName,
          status,
          args: trimmed ? tryParseJSON(trimmed) : undefined,
          error: attrs.error,
          seqIndex: match.index ?? 0,
        });
      }
    }
  }

  const toolCalls = Array.from(toolMap.values())
    .sort((a, b) => a.seqIndex - b.seqIndex)
    .map(({ seqIndex: _s, ...t }) => t);

  return {
    thoughts,
    reasoningFromTags: reasoningParts.join("\n\n").trim(),
    modelReasoning: modelReasoningParts.join("\n\n").trim(),
    toolCalls,
    busExchanges: options?.busExchanges ?? [],
  };
}

export function hasThinkingSnapshotContent(
  s: CompletedTurnThinkingSnapshot,
): boolean {
  return (
    s.thoughts.length > 0 ||
    Boolean(s.reasoningFromTags) ||
    Boolean(s.modelReasoning) ||
    s.toolCalls.length > 0 ||
    s.busExchanges.length > 0
  );
}
