import { generateText } from "ai";
import log from "electron-log";
import type { UserSettings } from "@/lib/schemas";
import type { LargeLanguageModel } from "@/lib/schemas";
import {
  getModelClient,
  getEffectiveModel,
  type GetModelClientOptions,
} from "@/ipc/utils/get_model_client";
import { estimateTokens } from "@/ipc/utils/token_utils";
import { getCompactionSummarizationModel } from "@/lib/summarization_model";

const logger = log.scope("post-turn-tool-summary");

/** Agentic loop / synthetic user messages (internal). */
const LEGACY_TOOL_RESULT_RE =
  /<tool_result\s+tool="([^"]+)"\s*>\s*([\s\S]*?)<\/tool_result>/gi;

/**
 * Persisted assistant transcript uses native Atlarix tags from
 * `processStreamChunks` / chat_only_handlers — not `<tool_result>`.
 */
const ATLARIX_NATIVE_RESULT_RE =
  /<atlarix-tool-result\s+([^>]+)>\s*([\s\S]*?)<\/atlarix-tool-result>/gi;

const ATLARIX_MCP_RESULT_RE =
  /<atlarix-mcp-tool-result\s+([^>]+)>\s*([\s\S]*?)<\/atlarix-mcp-tool-result>/gi;

type ResultBlockKind = "legacy" | "native" | "mcp";

type ParsedResultBlock = {
  kind: ResultBlockKind;
  start: number;
  end: number;
  toolName: string;
  body: string;
  /** Opening attribute string (e.g. `tool="read_file" status="complete"`). */
  openAttrs: string;
};

function toolNameFromAttrs(attrs: string): string | null {
  const m = /\btool="([^"]+)"/i.exec(attrs);
  return m?.[1] ?? null;
}

function openingIndicatesError(attrs: string): boolean {
  return /\bstatus\s*=\s*["']error["']/i.test(attrs);
}

function collectToolResultBlocks(content: string): ParsedResultBlock[] {
  const blocks: ParsedResultBlock[] = [];
  const addFromRegex = (re: RegExp, kind: ResultBlockKind) => {
    const r = new RegExp(re.source, re.flags);
    for (const m of content.matchAll(r)) {
      const full = m[0];
      const openAttrs = (m[1] ?? "").trim();
      const body = m[2] ?? "";
      const idx = m.index;
      if (idx == null) continue;
      const toolName = toolNameFromAttrs(openAttrs);
      if (!toolName) continue;
      blocks.push({
        kind,
        start: idx,
        end: idx + full.length,
        toolName,
        body,
        openAttrs,
      });
    }
  };

  addFromRegex(ATLARIX_NATIVE_RESULT_RE, "native");
  addFromRegex(ATLARIX_MCP_RESULT_RE, "mcp");

  for (const m of content.matchAll(
    new RegExp(LEGACY_TOOL_RESULT_RE.source, LEGACY_TOOL_RESULT_RE.flags),
  )) {
    const full = m[0];
    const toolName = m[1] ?? "";
    const body = m[2] ?? "";
    const idx = m.index;
    if (idx == null || !toolName) continue;
    blocks.push({
      kind: "legacy",
      start: idx,
      end: idx + full.length,
      toolName,
      body,
      openAttrs: `tool="${toolName}"`,
    });
  }

  blocks.sort((a, b) => a.start - b.start);
  const nonOverlapping: ParsedResultBlock[] = [];
  let lastEnd = -1;
  for (const b of blocks) {
    if (b.start < lastEnd) continue;
    nonOverlapping.push(b);
    lastEnd = b.end;
  }
  return nonOverlapping;
}

function wrapSummarizedBlock(
  kind: ResultBlockKind,
  toolName: string,
  openAttrs: string,
  nextInner: string,
): string {
  if (kind === "legacy") {
    return `<tool_result tool="${toolName}">\n${nextInner}\n</tool_result>`;
  }
  if (kind === "native") {
    return `<atlarix-tool-result ${openAttrs}>\n${nextInner}\n</atlarix-tool-result>`;
  }
  return `<atlarix-mcp-tool-result ${openAttrs}>\n${nextInner}\n</atlarix-mcp-tool-result>`;
}

const SUMMARY_PROMPT =
  "Summarize the following tool output in 3-5 sentences, keeping all " +
  "file paths, function names, key values, and error messages intact. " +
  "Drop verbose repetition, raw JSON structure, and boilerplate. " +
  "Output only the summary, no preamble.";

const MIN_TOKENS_TO_SUMMARIZE = 2000;
const SKIP_TOOLS = new Set(["write_file", "edit_file"]);

function toolOutputLooksLikeError(body: string): boolean {
  const t = body.trim();
  if (!t) return false;
  if (/^error\b/i.test(t)) return true;
  if (/\berror:\s*/i.test(t.slice(0, 400))) return true;
  if (/"success"\s*:\s*false/.test(t) || /'success'\s*:\s*false/.test(t)) {
    return true;
  }
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j = JSON.parse(t) as { success?: boolean; error?: unknown };
      if (j && typeof j === "object" && j.success === false) return true;
      if (j && typeof j === "object" && j.error != null) return true;
    } catch {
      /* not JSON */
    }
  }
  return false;
}

async function summarizeOneToolBody(
  toolName: string,
  body: string,
  summarizerModel: LargeLanguageModel,
  settings: UserSettings,
  mainOptions: GetModelClientOptions,
): Promise<string> {
  const { modelClient } = await getModelClient(summarizerModel, settings, mainOptions);
  const { text } = await generateText({
    model: modelClient.model,
    prompt: `${SUMMARY_PROMPT}\n\n---\n\n${body}`,
    maxOutputTokens: 1024,
    temperature: 0,
  });
  return (text ?? "").trim();
}

/**
 * After a turn completes: shrink very large tool outputs in persisted assistant
 * content (`<atlarix-tool-result>`, MCP variant, or legacy `<tool_result>`).
 * Silent (no UI). Skips small results, write/edit confirmations, and error-shaped output.
 */
export async function summarizeOversizedToolResultsInContent(
  content: string,
  opts: {
    settings: UserSettings;
    mainOptions: GetModelClientOptions;
  },
): Promise<string> {
  const { settings, mainOptions } = opts;
  const summarizerSpec = settings.autoModelRouting
    ? await getCompactionSummarizationModel(settings)
    : getEffectiveModel(settings);
  const summarizerModel: LargeLanguageModel = {
    provider: summarizerSpec.provider,
    name: summarizerSpec.name,
    ...(summarizerSpec.customModelId != null
      ? { customModelId: summarizerSpec.customModelId }
      : {}),
  };

  let out = content;
  const blocks = collectToolResultBlocks(content);
  const replacements: { start: number; end: number; next: string }[] = [];

  for (const block of blocks) {
    const { start, end, toolName, body, kind, openAttrs } = block;

    if (kind === "native" && openingIndicatesError(openAttrs)) continue;
    if (SKIP_TOOLS.has(toolName)) continue;
    if (toolOutputLooksLikeError(body)) continue;
    const beforeTok = estimateTokens(body);
    if (beforeTok <= MIN_TOKENS_TO_SUMMARIZE) continue;

    try {
      const summary = await summarizeOneToolBody(
        toolName,
        body,
        summarizerModel,
        settings,
        mainOptions,
      );
      if (!summary) continue;
      const note = `\n\n[summarized — original was ~${beforeTok}tokens]`;
      const nextInner = `${summary}${note}`;
      const nextFull = wrapSummarizedBlock(kind, toolName, openAttrs, nextInner);
      replacements.push({ start, end, next: nextFull });
      logger.info(
        `[post-turn-summary] Compressed tool result for ${toolName}: ${beforeTok}tok → ${estimateTokens(summary + note)}tok`,
      );
    } catch (e) {
      logger.warn(`[post-turn-summary] Failed for ${toolName}, leaving verbatim`, e);
    }
  }

  if (replacements.length === 0) return out;
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.next + out.slice(r.end);
  }
  return out;
}
