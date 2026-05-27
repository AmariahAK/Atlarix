import type { SourceItem } from "@/atoms/sourceAtoms";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import { parseToolResultEnvelope } from "@/lib/chat/stream-tool-display";

const WEB_SOURCE_TOOLS = new Set([
  "web_search",
  "deep_research",
  "deep_search",
  "read_url",
]);

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

function domainFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length >= 2) {
      return parts[parts.length - 2]!.charAt(0).toUpperCase() + parts[parts.length - 2]!.slice(1);
    }
    return host;
  } catch {
    return "Source";
  }
}

export function citationLabelForSource(source: SourceItem): string {
  if (source.url) {
    const d = domainFromUrl(source.url);
    if (d.length <= 14) return d;
    return `${d.slice(0, 12)}…`;
  }
  const t = source.title?.trim();
  if (t && t.length <= 16) return t;
  if (t) return `${t.slice(0, 14)}…`;
  return "Source";
}

function normalizeSource(raw: Record<string, unknown>, index: number): SourceItem | null {
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) return null;
  return {
    id: typeof raw.id === "string" ? raw.id : `src-${index}-${url}`,
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    url,
    snippet:
      typeof raw.snippet === "string"
        ? raw.snippet
        : typeof raw.content === "string"
          ? raw.content
          : "",
    favicon:
      typeof raw.favicon === "string"
        ? raw.favicon
        : `https://s2.googleusercontent.com/s2/favicons?domain_url=${encodeURIComponent(url)}&sz=32`,
    source: typeof raw.source === "string" ? raw.source : "web",
    score: typeof raw.score === "number" ? raw.score : undefined,
  };
}

function sourcesFromUnknown(raw: unknown): SourceItem[] {
  if (!raw) return [];
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { sources?: unknown }).sources)
      ? (raw as { sources: unknown[] }).sources
      : [];
  const out: SourceItem[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const s = normalizeSource(item as Record<string, unknown>, i);
    if (!s || seen.has(s.url)) return;
    seen.add(s.url);
    out.push(s);
  });
  return out;
}

/** Collect web sources from tool parts in a parsed assistant message. */
export function extractSourcesFromMessageParts(
  parts: AssistantMessagePart[],
): SourceItem[] {
  const out: SourceItem[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    if (part.type !== "tool" || !WEB_SOURCE_TOOLS.has(part.toolName)) continue;
    if (!part.resultText?.trim()) continue;

    const envelope = parseToolResultEnvelope(part.resultText);
    const candidates: unknown[] = [];

    if (envelope) {
      candidates.push(envelope.payload.sources);
      candidates.push(envelope.payload);
      const parsed = tryParseJson(part.resultText);
      if (parsed && typeof parsed === "object") {
        candidates.push((parsed as Record<string, unknown>).sources);
      }
    } else {
      candidates.push(tryParseJson(part.resultText));
    }

    for (const c of candidates) {
      for (const s of sourcesFromUnknown(c)) {
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        out.push(s);
      }
    }
  }

  return out;
}

/** Replace [^n] markers with atlarix-citation tags for the markdown tag parser. */
export function preprocessCitationMarkers(content: string): string {
  return content.replace(/\[\^(\d+)\]/g, (_m, n) => `<atlarix-citation index="${n}"></atlarix-citation>`);
}
