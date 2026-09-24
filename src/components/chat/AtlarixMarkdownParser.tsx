import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AtlarixWrite } from "./AtlarixWrite";
import { AtlarixRename } from "./AtlarixRename";
import { AtlarixDelete } from "./AtlarixDelete";
import { AtlarixEdit } from "./AtlarixEdit";
import { AtlarixCodebaseContext } from "./AtlarixCodebaseContext";
import { AtlarixThink } from "./AtlarixThink";
import { CodeHighlight } from "./CodeHighlight";
import { VisualArtifactCard } from "./VisualArtifactCard";
import { CustomTagState } from "./stateTypes";
import { AtlarixOutput } from "./AtlarixOutput";
import { AtlarixProblemSummary } from "./AtlarixProblemSummary";
import { IpcClient } from "@/ipc/ipc_client";
import { LOCALHOST_URL_RE } from "@/lib/browser/localhost-url";
import { AtlarixWebSearchResult } from "./AtlarixWebSearchResult";
import { AtlarixWebSearch } from "./AtlarixWebSearch";
import { AtlarixWebCrawl } from "./AtlarixWebCrawl";
import { AtlarixCodeSearchResult } from "./AtlarixCodeSearchResult";
import { AtlarixCodeSearch } from "./AtlarixCodeSearch";
import { AtlarixRead } from "./AtlarixRead";
import { mapActionToButton } from "./SuggestedActionButtons";
import { SuggestedAction } from "@/lib/schemas";
import { InlineWebCitation } from "./InlineWebCitation";
import { stripAssistantPlanForDisplay } from "@/lib/plan-cards/plan-card-renderer";
import { stripQuestionsArtifactForDisplay } from "@/lib/chat/ask-user-artifacts";
import { sanitizeMarkdownForDisplay } from "@/lib/chat/answer-display";
import type { PasteAttachmentMeta } from "@/ipc/ipc_types";
import {
  lookupTerminalPasteContent,
  lookupTextPasteContent,
} from "@/lib/chat/paste-attachment-meta";
import { PastedTextAttachmentChip } from "./PastedTextAttachmentChip";
import { BackgroundJobAttachmentChip } from "./BackgroundJobAttachmentChip";
import { TerminalOutputAttachmentChip } from "./TerminalOutputAttachmentChip";
import { findAttachmentTagsInContent } from "@/lib/chat/attachment-tag-parse";
import { normalizeThinkingTags } from "@/lib/thinking/normalize-thinking-tags";

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
      if (!url) return;
      e.preventDefault();
      // Links open in the system browser (the in-app panel was retired).
      IpcClient.getInstance().openExternalUrl(url);
    }}
  />
);

// A bare localhost:PORT URL (LOCALHOST_URL_RE) OR an "@/path:line" mention. The
// localhost pattern lets the user/agent click a schemeless dev-server URL in
// prose to open it in their browser (remark-gfm only autolinks full
// http(s):// URLs → those go through customLink).
const TOKEN_RE = new RegExp(
  `@\\/[^\\s]+?(?::\\d+(?:-\\d+)?)?|${LOCALHOST_URL_RE.source}`,
  "g",
);

function renderTextWithPathMentions(children: React.ReactNode) {
  const raw = typeof children === "string" ? children : String(children ?? "");
  if (!raw.includes("@/") && !new RegExp(LOCALHOST_URL_RE.source).test(raw))
    return children;

  // Render "@/absolute/path:line-range" as inline code (no leading "@"), and
  // bare localhost:PORT URLs as a highlighted link that opens in the user's browser.
  const parts: React.ReactNode[] = [];
  const re = new RegExp(TOKEN_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > last) parts.push(raw.slice(last, start));
    const token = m[0];
    if (token.startsWith("@/")) {
      parts.push(
        <code
          key={`${start}-${end}`}
          className="font-mono text-xs bg-muted px-1 py-0.5 rounded"
        >
          {token.slice(1)}
        </code>,
      );
    } else {
      const href = `http://${token}`;
      parts.push(
        <a
          key={`${start}-${end}`}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            IpcClient.getInstance().openExternalUrl(href);
          }}
          className="font-mono text-xs text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid cursor-pointer"
          title="Open in your browser"
        >
          {token}
        </a>,
      );
    }
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
    <th className="border border-border px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-2 py-1">{children}</td>
  ),
};

const ATTACHMENT_TAG_MARKERS = [
  "<atlarix-text-attachment",
  "<atlarix-terminal-attachment",
  "<atlarix-background-job",
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
          return (
            <VanillaMarkdownParser
              key={`md-${index}`}
              content={piece.content}
            />
          );
        }
        if (
          piece.tagInfo.tag === "atlarix-text-attachment" ||
          piece.tagInfo.tag === "atlarix-terminal-attachment" ||
          piece.tagInfo.tag === "atlarix-background-job"
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
    "atlarix-output",
    "atlarix-problem-report",
    "atlarix-chat-summary",
    "atlarix-sources",
    "atlarix-edit",
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
  let processedContent = normalizeThinkingTags(content);
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
  "atlarix-output",
  "atlarix-problem-report",
  "atlarix-chat-summary",
  "atlarix-sources",
  "atlarix-edit",
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
      contentPieces.push(
        ...parseCustomTagsInSegment(segment, inProgressTags, lastIndex),
      );
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
    contentPieces.push(
      ...parseCustomTagsInSegment(segment, inProgressTags, lastIndex),
    );
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
    case "atlarix-mcp-tool-result":
      // Legacy MCP tool tags are consumed into structured tool parts before
      // markdown rendering; render nothing if one ever reaches here.
      return null;

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

    case "atlarix-sources":
      // v10.1: provider-native search citations — consumed by
      // extractInlineSourcesFromContent for citation chips, never rendered.
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
    case "atlarix-tool-result":
      // Legacy tool tags are consumed into structured tool parts before markdown
      // rendering; render nothing if one ever reaches here.
      return null;

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

    case "atlarix-background-job": {
      const jobId = attributes.job_id || "job";
      return (
        <span className="inline-block my-1">
          <BackgroundJobAttachmentChip
            displayName={`id-${jobId}`}
            command={attributes.command || ""}
            outputTail={content.trim() || undefined}
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
    stripQuestionsArtifactForDisplay(stripAssistantPlanForDisplay(content)),
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
