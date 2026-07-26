import type { SourceItem } from "@/atoms/sourceAtoms";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import { parseToolResultEnvelope } from "@/lib/chat/stream-tool-display";

const WEB_SOURCE_TOOLS = new Set([
  "web_search",
  "deep_research",
  "deep_search",
  "read_url",
  // v10.1: provider-native web search tool keys (Anthropic reuses "web_search").
  "web_search_preview",
  "google_search",
]);

/**
 * File extensions that mean "this URL is a source file", not a page worth citing.
 *
 * Web search legitimately turns up raw code on GitHub/GitLab — `packages/core/src/
 * tools/ls.ts`, `app/agent/ls_tool.py` — and those crowd out the actual articles and
 * docs that answered the question. Note the app never cites files it read locally;
 * citations only ever come from WEB_SOURCE_TOOLS. This is web results pointing AT
 * code.
 *
 * Documentation extensions (.md, .mdx, .rst, .txt) are deliberately NOT here: a
 * README or a docs page is frequently the real answer, so dropping them would lose
 * genuine sources.
 */
const CODE_FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "scala",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "pl", "lua", "dart",
  "sh", "bash", "zsh", "fish", "ps1",
  "json", "yml", "yaml", "toml", "ini", "cfg", "lock",
  "css", "scss", "less", "sql", "graphql", "proto",
]);

/**
 * True when a URL points at a raw source file rather than a readable page.
 *
 * Extension-based rather than host-based on purpose: github.com also hosts issues,
 * discussions and docs that are perfectly good citations, so excluding the whole
 * domain would throw away real sources.
 */
export function isCodeFileSourceUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const last = pathname.split("/").filter(Boolean).pop();
  if (!last || !last.includes(".")) return false;
  const ext = last.split(".").pop()?.toLowerCase();
  return !!ext && CODE_FILE_EXTENSIONS.has(ext);
}

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
  // Filtered at the single point every citation path funnels through, so the strip,
  // the "+N more" dialog and the inline markers can't disagree about the set.
  if (isCodeFileSourceUrl(url)) return null;
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

/**
 * v10.1: provider-native search citations persisted in message content as
 * `<atlarix-sources>[{url,title},…]</atlarix-sources>` (emitted at stream end
 * by stream_chunk_tags). Extract + normalize them for the citation chips.
 */
export function extractInlineSourcesFromContent(content: string): SourceItem[] {
  if (!content || !content.includes("<atlarix-sources>")) return [];
  const out: SourceItem[] = [];
  const seen = new Set<string>();
  const re = /<atlarix-sources>([\s\S]*?)<\/atlarix-sources>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const parsed = tryParseJson(m[1].trim());
    for (const s of sourcesFromUnknown(parsed)) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      out.push(s);
    }
  }
  return out;
}

/** Replace [^n] markers with atlarix-citation tags for the markdown tag parser. */
export function preprocessCitationMarkers(content: string): string {
  return content.replace(/\[\^(\d+)\]/g, (_m, n) => `<atlarix-citation index="${n}"></atlarix-citation>`);
}
