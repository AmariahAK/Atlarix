import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AtlarixWrite } from "./AtlarixWrite";
import { AtlarixRename } from "./AtlarixRename";
import { AtlarixDelete } from "./AtlarixDelete";
import { AtlarixAddDependency } from "./AtlarixAddDependency";
import { AtlarixExecuteSql } from "./AtlarixExecuteSql";
import { AtlarixAddIntegration } from "./AtlarixAddIntegration";
import { AtlarixEdit } from "./AtlarixEdit";
import { AtlarixSearchReplace } from "./AtlarixSearchReplace";
import { AtlarixCodebaseContext } from "./AtlarixCodebaseContext";
import { AtlarixThink } from "./AtlarixThink";
import { CodeHighlight } from "./CodeHighlight";
import { useAtomValue } from "jotai";
import { isStreamingByIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
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

interface AtlarixMarkdownParserProps {
  content: string;
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

export const VanillaMarkdownParser = ({ content }: { content: string }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeHighlight,
        a: customLink,
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

/**
 * Custom component to parse markdown content with Atlarix-specific tags
 */
export const AtlarixMarkdownParser: React.FC<AtlarixMarkdownParserProps> = ({
  content,
}) => {
  const chatId = useAtomValue(selectedChatIdAtom);
  const isStreaming = useAtomValue(isStreamingByIdAtom).get(chatId!) ?? false;
  // Extract content pieces (markdown and custom tags)
  const contentPieces = useMemo(() => {
    return parseCustomTags(content);
  }, [content]);

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

  // Separate thinking content (thoughts + tools) from answer content
  const { thoughts, toolCalls, answerPieces } = useMemo(() => {
    const thoughts: string[] = [];
    const toolCalls: Array<{ id: string; toolName: string; status: 'success' | 'error' | 'running'; args?: any; error?: string }> = [];
    const answer: Array<{ piece: ContentPiece; index: number }> = [];
    // Use Map to deduplicate tools - key is "toolName_sequenceNum" to maintain order for same tool
    const toolMap = new Map<string, { id: string; toolName: string; status: 'success' | 'error' | 'running'; args?: any; error?: string; seqIndex: number }>();
    const toolNameCounts: Record<string, number> = {};

    contentPieces.forEach((piece, index) => {
      if (piece.type === 'custom-tag') {
        const tag = piece.tagInfo.tag;

        // Thoughts go to thinking card
        if (tag === 'think') {
          const content = piece.tagInfo.content?.trim();
          if (content) thoughts.push(content);
        }
        // Tools go to thinking card
        else if (
          tag === 'atlarix-tool-call' ||
          tag === 'atlarix-tool-result' ||
          tag === 'atlarix-mcp-tool-call' ||
          tag === 'atlarix-mcp-tool-result'
        ) {
          const attrs = piece.tagInfo.attributes;
          const toolName = attrs.tool || attrs.name || attrs.server || 'unknown';

          // Determine status: explicit status > inProgress check > default to success
          const isInProgress = piece.tagInfo.inProgress === true;
          let status: 'success' | 'error' | 'running' = 'success';
          if (attrs.status === 'error') {
            status = 'error';
          } else if (attrs.status === 'running' || isInProgress) {
            status = 'running';
          } else if (attrs.status === 'success') {
            status = 'success';
          }

          // Track sequence for same tool names
          const seqNum = toolNameCounts[toolName] || 0;
          const mapKey = `${toolName}_${seqNum}`;

          // Only increment counter if this is a new tool call (not a result update)
          if (tag.includes('tool-call') && !toolMap.has(mapKey)) {
            toolNameCounts[toolName] = seqNum + 1;
          }

          // Get the correct key - for results, find the running tool call with same name
          let targetKey = mapKey;
          if (tag.includes('tool-result')) {
            // Find the most recent running tool with this name
            for (let i = seqNum; i >= 0; i--) {
              const checkKey = `${toolName}_${i}`;
              if (toolMap.has(checkKey) && toolMap.get(checkKey)!.status === 'running') {
                targetKey = checkKey;
                break;
              }
            }
          }

          // Update or add tool entry - results update running calls to success/error
          const existing = toolMap.get(targetKey);
          if (existing) {
            // Only update if new status is more "final" (running < success/error)
            if (existing.status === 'running' && status !== 'running') {
              toolMap.set(targetKey, { ...existing, status, error: attrs.error });
            }
          } else {
            toolMap.set(targetKey, {
              id: `tool-${index}`,
              toolName,
              status,
              args: piece.tagInfo.content ? tryParseJSON(piece.tagInfo.content) : undefined,
              error: attrs.error,
              seqIndex: index,
            });
          }
        }
        // Other custom tags go to answer
        else {
          answer.push({ piece, index });
        }
      } else if (piece.type === 'markdown') {
        // Only add markdown with actual content to answer
        if (piece.content && piece.content.trim()) {
          answer.push({ piece, index });
        }
      }
    });

    // Convert Map to array, sorted by sequence index
    const deduplicatedTools = Array.from(toolMap.values())
      .sort((a, b) => a.seqIndex - b.seqIndex)
      .map(({ id, toolName, status, args, error }) => ({ id, toolName, status, args, error }));

    return { thoughts, toolCalls: deduplicatedTools, answerPieces: answer };
  }, [contentPieces]);

  // Import ThinkingCard
  const ThinkingCard = React.lazy(() => import('./ThinkingSection'));

  return (
    <>
      {/* CARD 1: Thinking (thoughts + tools) - Collapsed, independent */}
      {(thoughts.length > 0 || toolCalls.length > 0) && (
        <React.Suspense fallback={<div className="h-10 bg-slate-900/50 rounded-lg animate-pulse" />}>
          <ThinkingCard thoughts={thoughts} toolCalls={toolCalls} />
        </React.Suspense>
      )}

      {/* CARD 2: Response - The actual answer, completely separate */}
      {answerPieces.map(({ piece, index }) => (
        <React.Fragment key={index}>
          {piece.type === "markdown"
            ? piece.content && (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code: CodeHighlight,
                  a: customLink,
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
    </>
  );
};

// Helper to parse JSON safely
function tryParseJSON(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return str ? { raw: str } : undefined;
  }
}

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
    "atlarix-add-dependency",
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
    "atlarix-command",
    "atlarix-mcp-tool-call",
    "atlarix-mcp-tool-result",
    "atlarix-tool-call",
    "atlarix-tool-result",
  ];

  let processedContent = content;
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

/**
 * Parse the content to extract custom tags and markdown sections into a unified array
 */
function parseCustomTags(content: string): ContentPiece[] {
  const { processedContent, inProgressTags } = preprocessUnclosedTags(content);

  const customTagNames = [
    "atlarix-write",
    "atlarix-rename",
    "atlarix-delete",
    "atlarix-add-dependency",
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
    "atlarix-command",
    "atlarix-mcp-tool-call",
    "atlarix-mcp-tool-result",
    "atlarix-tool-call",
    "atlarix-tool-result",
  ];

  const tagPattern = new RegExp(
    `<(${customTagNames.join("|")})\\s*([^>]*)>(.*?)<\\/\\1>`,
    "gs",
  );

  const contentPieces: ContentPiece[] = [];
  let lastIndex = 0;
  let match;

  // Find all custom tags
  while ((match = tagPattern.exec(processedContent)) !== null) {
    const [fullMatch, tag, attributesStr, tagContent] = match;
    const startIndex = match.index;

    // Add the markdown content before this tag
    if (startIndex > lastIndex) {
      contentPieces.push({
        type: "markdown",
        content: processedContent.substring(lastIndex, startIndex),
      });
    }

    // Parse attributes
    const attributes: Record<string, string> = {};
    const attrPattern = /(\w+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2];
    }

    // Check if this tag was marked as in progress
    const tagInProgressSet = inProgressTags.get(tag);
    const isInProgress = tagInProgressSet?.has(startIndex);

    // Add the tag info
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

  // Add the remaining markdown content
  if (lastIndex < processedContent.length) {
    contentPieces.push({
      type: "markdown",
      content: processedContent.substring(lastIndex),
    });
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
  { isStreaming }: { isStreaming: boolean },
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

    case "atlarix-add-dependency":
      return (
        <AtlarixAddDependency
          node={{
            properties: {
              packages: attributes.packages || "",
            },
          }}
        >
          {content}
        </AtlarixAddDependency>
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

    default:
      return null;
  }
}
