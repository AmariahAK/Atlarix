import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import { isContextToolName } from "@/lib/chat/context-tools";

export type ToolMessagePart = Extract<AssistantMessagePart, { type: "tool" }>;

export type AssistantDisplayItem =
  | { kind: "item"; part: AssistantMessagePart }
  | { kind: "context_group"; tools: ToolMessagePart[] };

/**
 * Batch consecutive context tools into one "Gathered context" group (OpenCode-style).
 */
export function groupAssistantDisplayParts(
  parts: AssistantMessagePart[],
): AssistantDisplayItem[] {
  const out: AssistantDisplayItem[] = [];
  let contextBatch: ToolMessagePart[] = [];

  const flushContext = () => {
    if (contextBatch.length === 0) return;
    if (contextBatch.length === 1) {
      out.push({ kind: "item", part: contextBatch[0]! });
    } else {
      out.push({ kind: "context_group", tools: [...contextBatch] });
    }
    contextBatch = [];
  };

  for (const part of parts) {
    if (part.type === "tool" && isContextToolName(part.toolName)) {
      contextBatch.push(part);
      continue;
    }
    flushContext();
    out.push({ kind: "item", part });
  }
  flushContext();
  return out;
}
