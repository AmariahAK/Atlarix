/**
 * Renders a markdown segment that may contain atlarix-write / read / output tags
 * but not tool or thought tags (those are handled by AssistantMessageBody).
 */
import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripPartialQuestionsBlockForDisplay } from "@/ipc/utils/cleanFullResponse";
import { sanitizeMarkdownForDisplay } from "@/lib/chat/answer-display";
import { preprocessCitationMarkers } from "@/lib/chat/citation-sources";
import type { SourceItem } from "@/atoms/sourceAtoms";
import { CitationSourcesContext } from "./CitationSourcesContext";
import { CodeHighlight } from "./CodeHighlight";
import {
  customLink,
  markdownTableComponents,
  parseMarkdownSegmentPieces,
  renderMarkdownSegmentTag,
  renderTextWithPathMentions,
} from "./AtlarixMarkdownParser";

export function AtlarixMarkdownSegment({
  content,
  isStreaming,
  citationSources = [],
}: {
  content: string;
  isStreaming: boolean;
  citationSources?: SourceItem[];
}) {
  const displayContent = useMemo(() => {
    let s = sanitizeMarkdownForDisplay(content);
    if (isStreaming) s = stripPartialQuestionsBlockForDisplay(s);
    if (citationSources.length > 0) {
      s = preprocessCitationMarkers(s);
    }
    return s;
  }, [content, isStreaming, citationSources.length]);

  const pieces = useMemo(
    () => parseMarkdownSegmentPieces(displayContent),
    [displayContent],
  );

  if (!displayContent.trim()) return null;

  return (
    <CitationSourcesContext.Provider value={citationSources}>
      <>
        {pieces.map((piece, index) =>
          piece.type === "markdown" ? (
            piece.content.trim() ? (
              <ReactMarkdown
                key={index}
                remarkPlugins={[remarkGfm]}
                components={{
                  code: (props) => (
                    <CodeHighlight {...props} isStreaming={isStreaming} />
                  ),
                  a: customLink,
                  text: ({ children }) => (
                    <>{renderTextWithPathMentions(children)}</>
                  ),
                  ...markdownTableComponents,
                }}
              >
                {piece.content}
              </ReactMarkdown>
            ) : null
          ) : (
            <React.Fragment key={index}>
              {renderMarkdownSegmentTag(piece.tagInfo, { isStreaming })}
            </React.Fragment>
          ),
        )}
      </>
    </CitationSourcesContext.Provider>
  );
}
