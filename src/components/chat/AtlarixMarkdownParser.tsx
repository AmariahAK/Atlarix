import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AtlarixWrite } from "./AtlarixWrite";
import { AtlarixRename } from "./AtlarixRename";
import { AtlarixDelete } from "./AtlarixDelete";
import { AtlarixExecuteSql } from "./AtlarixExecuteSql";
import { AtlarixAddIntegration } from "./AtlarixAddIntegration";
import { AtlarixEdit } from "./AtlarixEdit";
import { AtlarixSearchReplace } from "./AtlarixSearchReplace";
import { AtlarixCodebaseContext } from "./AtlarixCodebaseContext";
import { AtlarixThink } from "./AtlarixThink";
import { CodeHighlight } from "./CodeHighlight";
import { VisualArtifactCard } from "./VisualArtifactCard";
import { useAtomValue } from "jotai";
import {
  activeChatIdAtom,
  isStreamingByIdAtom,
  selectedChatIdAtom,
} from "@/atoms/chatAtoms";
import { CustomTagState } from "./stateTypes";
import { AtlarixOutput } from "./AtlarixOutput";
import { AtlarixProblemSummary } from "./AtlarixProblemSummary";
import { IpcClient } from "@/ipc/ipc_client";
import { AtlarixMcpToolCall } from "./AtlarixMcpToolCall";
import { AtlarixMcpToolResult } from "./AtlarixMcpToolResult";
import { AtlarixWebSearchResult } from "./AtlarixWebSearchResult";
import { AtlarixWebSearch } from "./AtlarixWebSearch";
import { AtlarixWebCrawl } from "./AtlarixWebCrawl";
import { AtlarixCodeSearchResult } from "./AtlarixCodeSearchResult";
import { AtlarixCodeSearch } from "./AtlarixCodeSearch";
import { AtlarixRead } from "./AtlarixRead";
import { AtlarixToolCall } from "./AtlarixToolCall";
import { AtlarixToolResult } from "./AtlarixToolResult";
import { ToolSummary, ToolCall as ToolSummaryCall } from "../ToolSummary";
import { mapActionToButton } from "./ChatInput";
import { SuggestedAction } from "@/lib/schemas";
import { FixAllErrorsButton } from "./FixAllErrorsButton";
import { PlanSection } from "./PlanSection";
import { InlineWebCitation } from "./InlineWebCitation";
import {
  extractPlanFromContent,
  splitContentByPlanMarkers,
  stripAssistantPlanForDisplay,
  type PlanCardData,
} from "@/lib/plan-cards/plan-card-renderer";
import {
  extractVisibleAnswerMarkdown,
  isOnlyToolDebris,
  sanitizeMarkdownForDisplay,
} from "@/lib/chat/answer-display";
import { contentHasPlanArtifactMarker } from "@/lib/plan-cards/plan-card-renderer";
import { InlinePlanArtifactSlot } from "./InlinePlanArtifactSlot";
import { stripPartialQuestionsBlockForDisplay } from "@/ipc/utils/cleanFullResponse";
import { stripTaskCompleteTags } from "@/ipc/utils/thinking_tags";
import type { PasteAttachmentMeta } from "@/ipc/ipc_types";
import {
  lookupTerminalPasteContent,
  lookupTextPasteContent,
} from "@/lib/chat/paste-attachment-meta";
import { PastedTextAttachmentChip } from "./PastedTextAttachmentChip";
import { TerminalOutputAttachmentChip } from "./TerminalOutputAttachmentChip";
import { findAttachmentTagsInContent } from "@/lib/chat/attachment-tag-parse";

interface AtlarixMarkdownParserProps {
  content: string;
  /** Plan → Build: submit message + ledger steps */
  onPlanSwitchToBuild?: (autoMessage: string, planData: PlanCardData) => void;
  onPlanArtifactBuild?: (planId: string) => void;
  /**
   * When false, tool tags and plan chrome use completed (non-streaming) state even if
   * another message in this chat is currently streaming.
   */
  isActiveStreamMessage?: boolean;
  planArtifactBuildDisabled?: boolean;
}

type CustomTagInfo = {
  tag: string;
  attributes: Record<string, string>;
  content: string;
  fullMatch: string;
  inProgress?: boolean;
};

type ContentPiece =
  | { type: "markdown"; content: string }
  | { type: "custom-tag"; tagInfo: CustomTagInfo };

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str ? { raw: str } : undefined;
  }
}

type PartitionedContent = {
  thoughts: string[];
  reasoningTagParts: string[];
  modelReasoningParts: string[];
  toolCalls: Array<{
    id: string;
    toolName: string;
    status: "success" | "error" | "running";
    args?: unknown;
    error?: string;
  }>;
  answerPieces: Array<{ piece: ContentPiece; index: number }>;
};

function partitionContentPieces(
  contentPieces: ContentPiece[],
  isStreaming: boolean,
): PartitionedContent {
  const thoughts: string[] = [];
  const reasoningTagParts: string[] = [];
  const modelReasoningParts: string[] = [];
  const toolCalls: PartitionedContent["toolCalls"] = [];
  const answer: Array<{ piece: ContentPiece; index: number }> = [];
  const toolMap = new Map<
    string,
    {
      id: string;
      toolName: string;
      status: "success" | "error" | "running";
      args?: unknown;
      error?: string;
      seqIndex: number;
    }
  >();
  const toolNameCounts: Record<string, number> = {};

  contentPieces.forEach((piece, index) => {
    if (piece.type === "custom-tag") {
      const tag = piece.tagInfo.tag;

      if (tag === "think" || tag === "thinking") {
        const t = piece.tagInfo.content?.trim();
        if (t) thoughts.push(t);
      } else if (tag === "reasoning") {
        const t = piece.tagInfo.content?.trim();
        if (t) reasoningTagParts.push(t);
      } else if (tag === "redacted_thinking") {
        const t = piece.tagInfo.content?.trim();
        if (t) modelReasoningParts.push(t);
      } else if (
        tag === "atlarix-tool-call" ||
        tag === "atlarix-tool-result" ||
        tag === "atlarix-mcp-tool-call" ||
        tag === "atlarix-mcp-tool-result"
      ) {
        const attrs = piece.tagInfo.attributes;
        const toolName = attrs.tool || attrs.name || attrs.server || "unknown";
        const isInProgress = piece.tagInfo.inProgress === true;
        let status: "success" | "error" | "running" = "success";
        if (attrs.status === "error") {
          status = "error";
        } else if (attrs.status === "running" || isInProgress) {
          status = !isStreaming && isInProgress ? "error" : "running";
        } else if (attrs.status === "success") {
          status = "success";
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
            if (toolMap.has(checkKey) && toolMap.get(checkKey)!.status === "running") {
              targetKey = checkKey;
              break;
            }
          }
        }

        const existing = toolMap.get(targetKey);
        if (existing) {
          if (existing.status === "running" && status !== "running") {
            toolMap.set(targetKey, { ...existing, status, error: attrs.error });
          }
        } else {
          toolMap.set(targetKey, {
            id: targetKey,
            toolName,
            status,
            args: piece.tagInfo.content ? tryParseJSON(piece.tagInfo.content) : undefined,
            error: attrs.error,
            seqIndex: index,
          });
        }
      } else {
        answer.push({ piece, index });
      }
    } else if (piece.type === "markdown") {
      if (piece.content && piece.content.trim()) {
        answer.push({ piece, index });
      }
    }
  });

  const deduplicatedTools = Array.from(toolMap.values())
    .sort((a, b) => a.seqIndex - b.seqIndex)
    .map(({ id, toolName, status, args, error }) => ({
      id,
      toolName,
      status,
      args,
      error,
    }));

  const deduplicatedAnswer: Array<{ piece: ContentPiece; index: number }> = [];
  let lastMarkdownContent = "";

  for (const item of answer) {
    if (item.piece.type === "markdown") {
      const trimmed = item.piece.content.trim();
      if (trimmed === lastMarkdownContent) continue;
      lastMarkdownContent = trimmed;
    } else {
      lastMarkdownContent = "";
    }
    deduplicatedAnswer.push(item);
  }

  return {
    thoughts,
    reasoningTagParts,
    modelReasoningParts,
    toolCalls: deduplicatedTools,
    answerPieces: deduplicatedAnswer,
  };
}

const customLink = ({
  node: _node,
  ...props
}: {
  node?: any;
  [key: string]: any;
}) => (
  <a
    {...props}
    onClick={(e) => {
      const url = props.href;
      if (url) {
        e.preventDefault();
        IpcClient.getInstance().openExternalUrl(url);
      }
    }}
  />
);

function renderTextWithPathMentions(children: React.ReactNode) {
  const raw = typeof children === "string" ? children : String(children ?? "");
  if (!raw.includes("@/")) return children;

  // Render "@/absolute/path:line-range" as inline code without the leading "@".
  const parts: React.ReactNode[] = [];
  const re = /@\/[^\s]+?(?::\d+(?:-\d+)?)?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > last) parts.push(raw.slice(last, start));
    const token = m[0];
    parts.push(
      <code key={`${start}-${end}`} className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
        {token.slice(1)}
      </code>,
    );
    last = end;
  }
  if (last < raw.length) parts.push(raw.slice(last));
  return parts;
}

const markdownTableComponents = {
  table: ({ children }: { children?: React.ReactNode }) => (
    <VisualArtifactCard title="Table" layout="content">
      <table className="w-full min-w-full text-sm border-collapse table-auto">
        {children}
      </table>
    </VisualArtifactCard>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-muted/50">{children}</thead>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-2 py-1">{children}</td>
  ),
};

const ATTACHMENT_TAG_MARKERS = [
  "<atlarix-text-attachment",
  "<atlarix-terminal-attachment",
] as const;

function contentHasAttachmentTags(text: string): boolean {
  return ATTACHMENT_TAG_MARKERS.some((m) => text.includes(m));
}

/** User bubbles: render paste/terminal chips + markdown (not raw XML). */
export const UserMessageMarkdownParser = ({
  content,
  pasteAttachments,
}: {
  content: string;
  pasteAttachments?: PasteAttachmentMeta[];
}) => {
  const pieces = useMemo(() => parseCustomTags(content), [content]);

  if (!contentHasAttachmentTags(content)) {
    return <VanillaMarkdownParser content={content} />;
  }

  return (
    <>
      {pieces.map((piece, index) => {
        if (piece.type === "markdown") {
          const trimmed = piece.content.trim();
          if (!trimmed) return null;
          return <VanillaMarkdownParser key={`md-${index}`} content={piece.content} />;
        }
        if (
          piece.tagInfo.tag === "atlarix-text-attachment" ||
          piece.tagInfo.tag === "atlarix-terminal-attachment"
        ) {
          return (
            <React.Fragment key={`tag-${index}`}>
              {renderCustomTag(piece.tagInfo, {
                isStreaming: false,
                pasteAttachments,
              })}
            </React.Fragment>
          );
        }
        return null;
      })}
    </>
  );
};

export const VanillaMarkdownParser = ({ content }: { content: string }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeHighlight,
        a: customLink,
        ...markdownTableComponents,
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

/** Tailwind Typography classes for chat bubbles (assistant + user markdown). */
export const CHAT_MESSAGE_MARKDOWN_PROSE =
  "prose prose-sm dark:prose-invert max-w-none break-words " +
  "prose-headings:mb-1 prose-headings:mt-2 first:prose-headings:mt-0 " +
  "prose-p:mt-0 prose-p:mb-1 prose-p:leading-snug " +
  "prose-li:my-0.5 prose-ul:my-1 prose-ol:my-1 " +
  "prose-pre:my-1 prose-pre:py-2 prose-pre:leading-snug " +
  "prose-blockquote:my-1 prose-hr:my-2 prose-table:my-2";

/**
 * Custom component to parse markdown content with Atlarix-specific tags
 */
export const AtlarixMarkdownParser: React.FC<AtlarixMarkdownParserProps> = ({
  content,
  onPlanSwitchToBuild,
  onPlanArtifactBuild,
  isActiveStreamMessage,
  planArtifactBuildDisabled,
}) => {
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const chatId = activeChatId ?? selectedChatId;
  const streamingById = useAtomValue(isStreamingByIdAtom);
  const chatIsStreaming =
    chatId != null ? (streamingById.get(chatId) ?? false) : false;
  const isStreaming =
    isActiveStreamMessage === false
      ? false
      : isActiveStreamMessage === true
        ? true
        : chatIsStreaming;

  const markdownCodeComponent = useMemo(
    () =>
      function MarkdownCode(props: React.ComponentProps<typeof CodeHighlight>) {
        return <CodeHighlight {...props} isStreaming={isStreaming} />;
      },
    [isStreaming],
  );

  const displayContent = useMemo(() => {
    let s = stripTaskCompleteTags(stripAssistantPlanForDisplay(content));
    if (isStreaming) s = stripPartialQuestionsBlockForDisplay(s);
    return sanitizeMarkdownForDisplay(s);
  }, [content, isStreaming]);
  const hasPlanArtifactMarker = contentHasPlanArtifactMarker(content);
  const planCardData = useMemo(
    () => (hasPlanArtifactMarker ? null : extractPlanFromContent(content)),
    [content, hasPlanArtifactMarker],
  );
  // Extract content pieces (markdown and custom tags)
  const contentPieces = useMemo(() => {
    return parseCustomTags(displayContent);
  }, [displayContent]);

  // Extract error messages and track positions
  const { errorMessages, lastErrorIndex, errorCount } = useMemo(() => {
    const errors: string[] = [];
    let lastIndex = -1;
    let count = 0;

    contentPieces.forEach((piece, index) => {
      if (
        piece.type === "custom-tag" &&
        piece.tagInfo.tag === "atlarix-output" &&
        piece.tagInfo.attributes.type === "error"
      ) {
        const errorMessage = piece.tagInfo.attributes.message;
        if (errorMessage?.trim()) {
          errors.push(errorMessage.trim());
          count++;
          lastIndex = index;
        }
      }
    });

    return {
      errorMessages: errors,
      lastErrorIndex: lastIndex,
      errorCount: count,
    };
  }, [contentPieces]);

  const { answerPieces } = useMemo(
    () => partitionContentPieces(contentPieces, isStreaming),
    [contentPieces, isStreaming],
  );

  const contentSegments = useMemo(() => splitContentByPlanMarkers(content), [content]);
  const hasInlinePlanMarkers = contentSegments.some((s) => s.type === "plan-artifact");

  const segmentRenderItems = useMemo(() => {
    if (!hasInlinePlanMarkers) return null;
    return contentSegments.map((seg, si) => {
      if (seg.type === "plan-artifact") {
        return { kind: "plan" as const, planId: seg.planId, key: `plan-${si}` };
      }
      let s = stripTaskCompleteTags(stripAssistantPlanForDisplay(seg.content));
      if (isStreaming) s = stripPartialQuestionsBlockForDisplay(s);
      const pieces = parseCustomTags(s);
      const { answerPieces: segAnswers } = partitionContentPieces(pieces, isStreaming);
      return { kind: "answers" as const, key: `md-${si}`, answerPieces: segAnswers };
    });
  }, [contentSegments, hasInlinePlanMarkers, isStreaming]);

  const answerFallback = useMemo(
    () => extractVisibleAnswerMarkdown(content),
    [content],
  );

  const segmentHasVisibleAnswer =
    segmentRenderItems?.some(
      (item) =>
        item.kind === "answers" &&
        item.answerPieces.some(
          (ap) =>
            ap.piece.type === "markdown" ||
            (ap.piece.type === "custom-tag" && ap.piece.tagInfo.tag !== "think"),
        ),
    ) ?? false;

  const sanitizedFallback = useMemo(
    () => sanitizeMarkdownForDisplay(answerFallback),
    [answerFallback],
  );

  const showAnswerFallback =
    sanitizedFallback.length > 0 &&
    !isOnlyToolDebris(sanitizedFallback) &&
    (hasInlinePlanMarkers ? !segmentHasVisibleAnswer : answerPieces.length === 0);

  return (
    <>
      {hasInlinePlanMarkers && segmentRenderItems
        ? segmentRenderItems.map((item) =>
            item.kind === "plan" ? (
              <InlinePlanArtifactSlot
                key={item.key}
                planId={item.planId}
                chatId={chatId}
                onBuild={onPlanArtifactBuild}
                buildDisabled={planArtifactBuildDisabled}
              />
            ) : (
              <React.Fragment key={item.key}>
                {item.answerPieces.map(({ piece, index }) => (
                  <React.Fragment key={`${item.key}-${index}`}>
                    {piece.type === "markdown"
                      ? piece.content && (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              code: markdownCodeComponent,
                              a: customLink,
                              text: ({ children }) => (
                                <>{renderTextWithPathMentions(children)}</>
                              ),
                              ...markdownTableComponents,
                            }}
                          >
                            {piece.content}
                          </ReactMarkdown>
                        )
                      : renderCustomTag(piece.tagInfo, { isStreaming })}
                  </React.Fragment>
                ))}
              </React.Fragment>
            ),
          )
        : answerPieces.map(({ piece, index }) => (
            <React.Fragment key={index}>
              {piece.type === "markdown"
                ? piece.content && (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        code: markdownCodeComponent,
                        a: customLink,
                        text: ({ children }) => (
                          <>{renderTextWithPathMentions(children)}</>
                        ),
                        ...markdownTableComponents,
                      }}
                    >
                      {piece.content}
                    </ReactMarkdown>
                  )
                : renderCustomTag(piece.tagInfo, { isStreaming })}
              {index === lastErrorIndex &&
                errorCount > 1 &&
                !isStreaming &&
                chatId && (
                  <div className="mt-3 w-full flex">
                    <FixAllErrorsButton
                      errorMessages={errorMessages}
                      chatId={chatId}
                    />
                  </div>
                )}
            </React.Fragment>
          ))}
      {showAnswerFallback ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code: markdownCodeComponent,
            a: customLink,
            text: ({ children }) => <>{renderTextWithPathMentions(children)}</>,
            ...markdownTableComponents,
          }}
        >
          {sanitizedFallback}
        </ReactMarkdown>
      ) : null}

      {/* v3.6: Plan card when content matches structured / phased plan (visible while streaming once parseable) */}
      {planCardData ? (
        <PlanSection
          key={isStreaming ? "plan-streaming" : "plan-complete"}
          data={planCardData}
          initialExpanded={!isStreaming}
          onSwitchToBuild={onPlanSwitchToBuild}
        />
      ) : null}
    </>
  );
};

/**
 * Pre-process content to handle unclosed custom tags
 * Adds closing tags at the end of the content for any unclosed custom tags
 * Assumes the opening tags are complete and valid
 * Returns the processed content and a map of in-progress tags
 */
function preprocessUnclosedTags(content: string): {
  processedContent: string;
  inProgressTags: Map<string, Set<number>>;
} {
  const customTagNames = [
    "atlarix-write",
    "atlarix-rename",
    "atlarix-delete",
    "atlarix-execute-sql",
    "atlarix-add-integration",
    "atlarix-output",
    "atlarix-problem-report",
    "atlarix-chat-summary",
    "atlarix-edit",
    "atlarix-search-replace",
    "atlarix-codebase-context",
    "atlarix-web-search-result",
    "atlarix-web-search",
    "atlarix-web-crawl",
    "atlarix-read",
    "think",
    "thinking",
    "reasoning",
    "redacted_thinking",
    "atlarix-command",
    "atlarix-mcp-tool-call",
    "atlarix-mcp-tool-result",
    "atlarix-tool-call",
    "atlarix-tool-result",
  ];

  // Attachment tags (incl. self-closing display stubs) are parsed via findAttachmentTagsInContent.

  // Normalize provider-emitted variants to a single tag name so mismatched
  // open/close tags don't leak into the visible markdown stream.
  let processedContent = content
    .replace(/<thinking(\s[^>]*)?>/gi, (_m, attrs = "") => `<redacted_thinking${attrs}>`)
    .replace(/<\/thinking>/gi, "</think>");
  // Map to track which tags are in progress and their positions
  const inProgressTags = new Map<string, Set<number>>();

  // For each tag type, check if there are unclosed tags
  for (const tagName of customTagNames) {
    // Count opening and closing tags
    const openTagPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
    const closeTagPattern = new RegExp(`</${tagName}>`, "g");

    // Track the positions of opening tags
    const openingMatches: RegExpExecArray[] = [];
    let match;

    // Reset regex lastIndex to start from the beginning
    openTagPattern.lastIndex = 0;

    while ((match = openTagPattern.exec(processedContent)) !== null) {
      openingMatches.push({ ...match });
    }

    const openCount = openingMatches.length;
    const closeCount = (processedContent.match(closeTagPattern) || []).length;

    // If we have more opening than closing tags
    const missingCloseTags = openCount - closeCount;
    if (missingCloseTags > 0) {
      // Add the required number of closing tags at the end
      processedContent += Array(missingCloseTags)
        .fill(`</${tagName}>`)
        .join("");

      // Mark the last N tags as in progress where N is the number of missing closing tags
      const inProgressIndexes = new Set<number>();
      const startIndex = openCount - missingCloseTags;
      for (let i = startIndex; i < openCount; i++) {
        inProgressIndexes.add(openingMatches[i].index);
      }
      inProgressTags.set(tagName, inProgressIndexes);
    }
  }

  return { processedContent, inProgressTags };
}

const REGEX_CUSTOM_TAG_NAMES = [
  "atlarix-write",
  "atlarix-rename",
  "atlarix-delete",
  "atlarix-execute-sql",
  "atlarix-add-integration",
  "atlarix-output",
  "atlarix-problem-report",
  "atlarix-chat-summary",
  "atlarix-edit",
  "atlarix-search-replace",
  "atlarix-codebase-context",
  "atlarix-web-search-result",
  "atlarix-web-search",
  "atlarix-web-crawl",
  "atlarix-code-search-result",
  "atlarix-code-search",
  "atlarix-read",
  "think",
  "thinking",
  "reasoning",
  "redacted_thinking",
  "atlarix-command",
  "atlarix-mcp-tool-call",
  "atlarix-mcp-tool-result",
  "atlarix-tool-call",
  "atlarix-tool-result",
] as const;

function parseCustomTagsInSegment(
  segment: string,
  inProgressTags: Map<string, Set<number>>,
  segmentStartOffset: number,
): ContentPiece[] {
  const tagPattern = new RegExp(
    `<(${REGEX_CUSTOM_TAG_NAMES.join("|")})\\s*([^>]*)>(.*?)<\\/\\1>`,
    "gs",
  );

  const contentPieces: ContentPiece[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(segment)) !== null) {
    const [fullMatch, tag, attributesStr, tagContent] = match;
    const startIndex = match.index;

    if (startIndex > lastIndex) {
      contentPieces.push({
        type: "markdown",
        content: segment.substring(lastIndex, startIndex),
      });
    }

    const attributes: Record<string, string> = {};
    const attrPattern = /(\w+)="([^"]*)"/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2];
    }

    const tagInProgressSet = inProgressTags.get(tag);
    const isInProgress = tagInProgressSet?.has(segmentStartOffset + startIndex);

    contentPieces.push({
      type: "custom-tag",
      tagInfo: {
        tag,
        attributes,
        content: tagContent,
        fullMatch,
        inProgress: isInProgress || false,
      },
    });

    lastIndex = startIndex + fullMatch.length;
  }

  if (lastIndex < segment.length) {
    contentPieces.push({
      type: "markdown",
      content: segment.substring(lastIndex),
    });
  }

  return contentPieces;
}

/**
 * Parse the content to extract custom tags and markdown sections into a unified array
 */
function parseCustomTags(content: string): ContentPiece[] {
  const { processedContent, inProgressTags } = preprocessUnclosedTags(content);
  const attachmentTags = findAttachmentTagsInContent(processedContent);

  if (attachmentTags.length === 0) {
    return parseCustomTagsInSegment(processedContent, inProgressTags, 0);
  }

  const contentPieces: ContentPiece[] = [];
  let lastIndex = 0;

  for (const at of attachmentTags) {
    if (at.startIndex > lastIndex) {
      const segment = processedContent.substring(lastIndex, at.startIndex);
      contentPieces.push(...parseCustomTagsInSegment(segment, inProgressTags, lastIndex));
    }

    const tagInProgressSet = inProgressTags.get(at.tag);
    const isInProgress = tagInProgressSet?.has(at.startIndex);

    contentPieces.push({
      type: "custom-tag",
      tagInfo: {
        tag: at.tag,
        attributes: at.attributes,
        content: at.content,
        fullMatch: at.fullMatch,
        inProgress: isInProgress || false,
      },
    });

    lastIndex = at.startIndex + at.fullMatch.length;
  }

  if (lastIndex < processedContent.length) {
    const segment = processedContent.substring(lastIndex);
    contentPieces.push(...parseCustomTagsInSegment(segment, inProgressTags, lastIndex));
  }

  return contentPieces;
}

function getState({
  isStreaming,
  inProgress,
}: {
  isStreaming?: boolean;
  inProgress?: boolean;
}): CustomTagState {
  if (!inProgress) {
    return "finished";
  }
  return isStreaming ? "pending" : "aborted";
}

/**
 * Render a custom tag based on its type
 */
function renderCustomTag(
  tagInfo: CustomTagInfo,
  {
    isStreaming,
    pasteAttachments,
  }: { isStreaming: boolean; pasteAttachments?: PasteAttachmentMeta[] },
): React.ReactNode {
  const { tag, attributes, content, inProgress } = tagInfo;

  switch (tag) {
    case "atlarix-read":
      return (
        <AtlarixRead
          node={{
            properties: {
              path: attributes.path || "",
            },
          }}
        >
          {content}
        </AtlarixRead>
      );
    case "atlarix-web-search":
      return (
        <AtlarixWebSearch
          node={{
            properties: {},
          }}
        >
          {content}
        </AtlarixWebSearch>
      );
    case "atlarix-web-crawl":
      return (
        <AtlarixWebCrawl
          node={{
            properties: {},
          }}
        >
          {content}
        </AtlarixWebCrawl>
      );
    case "atlarix-code-search":
      return (
        <AtlarixCodeSearch
          node={{
            properties: {},
          }}
        >
          {content}
        </AtlarixCodeSearch>
      );
    case "atlarix-code-search-result":
      return (
        <AtlarixCodeSearchResult
          node={{
            properties: {},
          }}
        >
          {content}
        </AtlarixCodeSearchResult>
      );
    case "atlarix-web-search-result":
      return (
        <AtlarixWebSearchResult
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </AtlarixWebSearchResult>
      );
    case "think":
    case "thinking":
    case "reasoning":
    case "redacted_thinking":
      return (
        <AtlarixThink
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </AtlarixThink>
      );
    case "atlarix-write":
      return (
        <AtlarixWrite
          node={{
            properties: {
              path: attributes.path || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </AtlarixWrite>
      );

    case "atlarix-rename":
      return (
        <AtlarixRename
          node={{
            properties: {
              from: attributes.from || "",
              to: attributes.to || "",
            },
          }}
        >
          {content}
        </AtlarixRename>
      );

    case "atlarix-delete":
      return (
        <AtlarixDelete
          node={{
            properties: {
              path: attributes.path || "",
            },
          }}
        >
          {content}
        </AtlarixDelete>
      );

    case "atlarix-execute-sql":
      return (
        <AtlarixExecuteSql
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
              description: attributes.description || "",
            },
          }}
        >
          {content}
        </AtlarixExecuteSql>
      );

    case "atlarix-add-integration":
      return (
        <AtlarixAddIntegration
          node={{
            properties: {
              provider: attributes.provider || "",
            },
          }}
        >
          {content}
        </AtlarixAddIntegration>
      );

    case "atlarix-edit":
      return (
        <AtlarixEdit
          node={{
            properties: {
              path: attributes.path || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </AtlarixEdit>
      );

    case "atlarix-search-replace":
      return (
        <AtlarixSearchReplace
          node={{
            properties: {
              path: attributes.path || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </AtlarixSearchReplace>
      );

    case "atlarix-codebase-context":
      return (
        <AtlarixCodebaseContext
          node={{
            properties: {
              files: attributes.files || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </AtlarixCodebaseContext>
      );

    case "atlarix-mcp-tool-call":
      return (
        <AtlarixMcpToolCall
          node={{
            properties: {
              serverName: attributes.server || "",
              toolName: attributes.tool || "",
            },
          }}
        >
          {content}
        </AtlarixMcpToolCall>
      );

    case "atlarix-mcp-tool-result":
      return (
        <AtlarixMcpToolResult
          node={{
            properties: {
              serverName: attributes.server || "",
              toolName: attributes.tool || "",
            },
          }}
        >
          {content}
        </AtlarixMcpToolResult>
      );

    case "atlarix-output":
      return (
        <AtlarixOutput
          type={attributes.type as "warning" | "error"}
          message={attributes.message}
        >
          {content}
        </AtlarixOutput>
      );

    case "atlarix-problem-report":
      return (
        <AtlarixProblemSummary summary={attributes.summary}>
          {content}
        </AtlarixProblemSummary>
      );

    case "atlarix-chat-summary":
      // Don't render anything for atlarix-chat-summary
      return null;

    case "atlarix-command":
      if (attributes.type) {
        const action = {
          id: attributes.type,
        } as SuggestedAction;
        return <>{mapActionToButton(action)}</>;
      }
      return null;

    case "atlarix-tool-call":
      return (
        <AtlarixToolCall
          node={{
            properties: {
              tool: attributes.tool || attributes.name || "",
              status: attributes.status || "success",
            },
          }}
        >
          {content}
        </AtlarixToolCall>
      );

    case "atlarix-tool-result":
      return (
        <AtlarixToolResult
          node={{
            properties: {
              tool: attributes.tool || attributes.name || "",
              status: attributes.status || "success",
              error: attributes.error || "",
            },
          }}
        >
          {content}
        </AtlarixToolResult>
      );

    case "atlarix-citation": {
      const idx = Number(attributes.index ?? attributes.n ?? "0");
      if (!Number.isFinite(idx) || idx < 1) return null;
      return <InlineWebCitation index={idx} />;
    }

    case "atlarix-text-attachment": {
      const filename = attributes.filename || "attachment";
      const textBody = pasteAttachments?.length
        ? lookupTextPasteContent(filename, pasteAttachments) || content.trim()
        : content.trim();
      return (
        <span className="inline-block my-1">
          <PastedTextAttachmentChip
            content={textBody}
            displayName={filename}
            readOnly
          />
        </span>
      );
    }

    case "atlarix-terminal-attachment": {
      const label = attributes.label || "Terminal output";
      const terminalBody = pasteAttachments?.length
        ? lookupTerminalPasteContent(label, pasteAttachments)
        : {
            content: content.trim(),
            displayContent: attributes.displayContent,
          };
      return (
        <span className="inline-block my-1">
          <TerminalOutputAttachmentChip
            content={terminalBody.content}
            displayContent={terminalBody.displayContent}
            displayName={label}
            readOnly
          />
        </span>
      );
    }

    default:
      return null;
  }
}

const SEGMENT_EXCLUDED_TAGS = new Set([
  "think",
  "thinking",
  "reasoning",
  "redacted_thinking",
  "atlarix-tool-call",
  "atlarix-tool-result",
  "atlarix-mcp-tool-call",
  "atlarix-mcp-tool-result",
]);

/** Parse markdown segments for AssistantMessageBody (no thought/tool tags). */
export function parseMarkdownSegmentPieces(content: string): ContentPiece[] {
  const sanitized = sanitizeMarkdownForDisplay(
    stripTaskCompleteTags(stripAssistantPlanForDisplay(content)),
  );
  return parseCustomTags(sanitized).filter(
    (piece) =>
      piece.type === "markdown" ||
      !SEGMENT_EXCLUDED_TAGS.has(piece.tagInfo.tag),
  );
}

export function renderMarkdownSegmentTag(
  tagInfo: CustomTagInfo,
  opts: { isStreaming: boolean },
): React.ReactNode {
  if (SEGMENT_EXCLUDED_TAGS.has(tagInfo.tag)) return null;
  return renderCustomTag(tagInfo, opts);
}

export { customLink, markdownTableComponents, renderTextWithPathMentions };
