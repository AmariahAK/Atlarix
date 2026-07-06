import { parseToolResultEnvelope } from "@/lib/chat/answer-display";

function unwrapEnvelopeInner(envelope: Record<string, unknown>): string {
  const r = envelope.result;
  if (typeof r === "string") return r;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const nested = r as Record<string, unknown>;
    if (typeof nested.markdown === "string") return nested.markdown;
    if (typeof nested.result === "string") return nested.result;
    try {
      return JSON.stringify(nested);
    } catch {
      return "";
    }
  }
  if (typeof envelope.message === "string") return envelope.message;
  if (typeof envelope.error === "string") return envelope.error;
  return "";
}

/** Guess tool name when only a bare `{ success, result }` envelope is present. */
export function inferToolNameFromEnvelopeRaw(raw: string): string {
  const parsed = parseToolResultEnvelope(raw);
  if (!parsed) return "unknown";
  const inner = unwrapEnvelopeInner(parsed.envelope);
  if (!inner) return "unknown";

  if (
    /^#\s*Repo overview/i.test(inner) ||
    /## Top-level structure/i.test(inner) ||
    /Dominant languages/i.test(inner)
  ) {
    return "get_repo_overview";
  }
  if (
    /Found \d+ match/i.test(inner) ||
    /requested_mode/i.test(inner) ||
    /engine":"ripgrep"/i.test(inner) ||
    /mode":"text"/i.test(inner)
  ) {
    return "search_code";
  }
  if (/^File:/m.test(inner) || /Lines \d+-\d+/i.test(inner) || /^```/m.test(inner)) {
    return "read_file";
  }
  if (/📁|Top-level structure/i.test(inner) && inner.length < 500) {
    return "explore_folder";
  }
  return "unknown";
}
