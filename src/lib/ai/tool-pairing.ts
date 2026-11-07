/**
 * Tool calls and results paired, checked before a request is sent.
 *
 * Every provider refuses a tool result whose call is not in the assistant
 * message just before it, and a call with no result ("Messages with role 'tool'
 * must be a response to a preceding message with 'tool_calls'"; Anthropic:
 * "unexpected `tool_use_id` found in `tool_result` blocks"). And the history is
 * resent every turn, so one broken pair fails every later request in that chat
 * (HANDOFF 2026-10-31 item 1c: a VS Code chat, 10 of 16 requests, after a
 * compaction cut that 15.12's c3e7acd2 fixed at one site of two).
 *
 * The cuts that make history shorter keep pairs together themselves; this is
 * the net under all of them. A paired history comes back as the SAME array (the
 * common case, so the prompt cache holds and nothing is copied). A broken one is
 * repaired: a result that a message landed between is moved back under its
 * call, a result with no call is dropped, a call with no result is dropped, and
 * a message left empty goes. Provider-run tools (a web search whose result
 * rides in the assistant message) are left to native-history.ts.
 */
import type { ModelMessage } from "ai";

type Part = { type?: string; toolCallId?: unknown; providerExecuted?: unknown };

function partsOf(m: ModelMessage): Part[] {
  return Array.isArray(m.content) ? (m.content as unknown as Part[]) : [];
}

const isLocalCall = (p: Part): boolean =>
  p?.type === "tool-call" && p.providerExecuted !== true && typeof p.toolCallId === "string";
const isResult = (p: Part): boolean => p?.type === "tool-result" && typeof p.toolCallId === "string";

/** Each result answers a call of the assistant message just before its run of tool messages. */
function isPaired(messages: ModelMessage[]): boolean {
  let open: Set<unknown> | null = null;
  const answered = new Set<unknown>();
  const unanswered = () => open != null && [...open].some((id) => !answered.has(id));
  for (const m of messages) {
    if (m.role === "tool") {
      for (const p of partsOf(m)) {
        if (!isResult(p)) continue;
        if (!open?.has(p.toolCallId)) return false;
        answered.add(p.toolCallId);
      }
      continue;
    }
    if (unanswered()) return false;
    open = null;
    answered.clear();
    if (m.role === "assistant") {
      const calls = partsOf(m).filter(isLocalCall).map((p) => p.toolCallId);
      if (calls.length) open = new Set(calls);
    }
  }
  return !unanswered();
}

export interface ToolPairing {
  messages: ModelMessage[];
  repaired: boolean;
  droppedCalls: number;
  droppedResults: number;
}

export function pairToolMessages(messages: ModelMessage[]): ToolPairing {
  if (isPaired(messages)) return { messages, repaired: false, droppedCalls: 0, droppedResults: 0 };

  // Where each call was made, and the first result for it after that.
  const callAt = new Map<unknown, number>();
  messages.forEach((m, i) => {
    if (m.role === "assistant") for (const p of partsOf(m)) if (isLocalCall(p) && !callAt.has(p.toolCallId)) callAt.set(p.toolCallId, i);
  });
  const resultFor = new Map<unknown, Part>();
  messages.forEach((m, i) => {
    if (m.role !== "tool") return;
    for (const p of partsOf(m)) {
      const at = isResult(p) ? callAt.get(p.toolCallId) : undefined;
      if (at !== undefined && at < i && !resultFor.has(p.toolCallId)) resultFor.set(p.toolCallId, p);
    }
  });

  let droppedCalls = 0;
  let droppedResults = 0;
  const out: ModelMessage[] = [];
  const placed = new Set<unknown>();
  messages.forEach((m, i) => {
    const parts = partsOf(m);
    if (m.role === "assistant" && parts.some(isLocalCall)) {
      const kept = parts.filter((p) => {
        if (!isLocalCall(p)) return true;
        // The same call twice in one history: the second has no result of its own.
        const ok = resultFor.has(p.toolCallId) && callAt.get(p.toolCallId) === i && !placed.has(p.toolCallId);
        if (ok) placed.add(p.toolCallId);
        else droppedCalls++;
        return ok;
      });
      if (kept.length) out.push({ ...m, content: kept } as unknown as ModelMessage);
      // Its results, right under it, in call order.
      const results = kept.filter(isLocalCall).map((p) => resultFor.get(p.toolCallId)!);
      if (results.length) out.push({ role: "tool", content: results } as unknown as ModelMessage);
      return;
    }
    if (m.role === "tool") {
      // Results were placed under their calls above; what else it carries stays.
      const rest = parts.filter((p) => {
        if (!isResult(p)) return true;
        if (resultFor.get(p.toolCallId) !== p) droppedResults++;
        return false;
      });
      if (rest.length) out.push({ ...m, content: rest } as unknown as ModelMessage);
      return;
    }
    out.push(m);
  });
  return { messages: out, repaired: true, droppedCalls, droppedResults };
}
