/**
 * Renders a markdown segment that may contain atlarix-write / read / output tags
 * but not tool or thought tags (those are handled by AssistantMessageBody).
 */
import React, { memo, useMemo } from "react";
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

/**
 * One markdown block rendered by ReactMarkdown. Memoized on (content, isStreaming)
 * so a frozen prefix block is parsed once and skipped on every subsequent stream
 * flush — only the growing tail block re-parses. Deps mirror the render inputs.
 */
const MarkdownBlock = memo(
  function MarkdownBlock({
    content,
    isStreaming,
  }: {
    content: string;
    isStreaming: boolean;
  }) {
    if (!content.trim()) return null;
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: (props) => <CodeHighlight {...props} isStreaming={isStreaming} />,
          a: customLink,
          text: ({ children }) => <>{renderTextWithPathMentions(children)}</>,
          ...markdownTableComponents,
        }}
      >
        {content}
      </ReactMarkdown>
    );
  },
  (prev, next) =>
    prev.content === next.content && prev.isStreaming === next.isStreaming,
);

/**
 * A line that belongs to a multi-line markdown construct (list, table,
 * blockquote) whose items must render inside ONE ReactMarkdown root — cutting
 * between them would split the construct into two roots (double bullets, broken
 * table) mid-stream. Headings/paragraphs are self-contained and safe to cut at.
 */
function isBlockContinuationLine(line: string): boolean {
  const t = line.trimStart();
  return (
    /^[-*+]\s/.test(t) || // unordered list item
    /^\d+[.)]\s/.test(t) || // ordered list item
    t.startsWith("|") || // table row
    t.startsWith(">") // blockquote
  );
}

/**
 * Split a growing markdown string into a stable "frozen" prefix (completed
 * blocks) and the in-progress "tail". Cuts at the LAST newline that is (a) not
 * inside an open ``` fence and (b) not between the lines of a list/table/
 * blockquote. During streaming the frozen prefix is byte-identical flush-to-
 * flush, so MarkdownBlock's memo skips re-parsing it — the O(len)×20Hz whole-
 * answer re-parse collapses to O(tail). `sanitizeMarkdownForDisplay` has already
 * collapsed paragraph `\n\n` to single `\n` upstream, so we cut on `\n`. Returns
 * tail-only (empty frozen) when no safe cut exists yet — correctness over perf.
 */
export function splitFrozenTail(content: string): { frozen: string; tail: string } {
  let cut = content.lastIndexOf("\n");
  while (cut > 0) {
    const before = content.slice(0, cut);
    // Balanced ``` fences before the cut ⇒ the cut is not inside a code block.
    const balanced = ((before.match(/```/g) ?? []).length) % 2 === 0;
    if (balanced) {
      const prevLine = before.slice(before.lastIndexOf("\n") + 1);
      const nextNl = content.indexOf("\n", cut + 1);
      const nextLine = content.slice(cut + 1, nextNl === -1 ? undefined : nextNl);
      // Unsafe ONLY when the cut falls BETWEEN two continuation lines (i.e. inside
      // a list/table/blockquote). Cutting before a construct starts, or after one
      // ends, leaves the construct whole in a single block — that's fine.
      const insideConstruct =
        isBlockContinuationLine(prevLine) && isBlockContinuationLine(nextLine);
      if (!insideConstruct) {
        return { frozen: before, tail: content.slice(cut) };
      }
    }
    cut = content.lastIndexOf("\n", cut - 1);
  }
  return { frozen: "", tail: content };
}

function AtlarixMarkdownSegmentImpl({
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
        {pieces.map((piece, index) => {
          if (piece.type !== "markdown") {
            return (
              <React.Fragment key={index}>
                {renderMarkdownSegmentTag(piece.tagInfo, { isStreaming })}
              </React.Fragment>
            );
          }
          if (!piece.content.trim()) return null;
          // While streaming, freeze completed blocks so only the growing tail
          // re-parses. On completion, render the whole piece as one block.
          if (isStreaming) {
            const { frozen, tail } = splitFrozenTail(piece.content);
            return (
              <React.Fragment key={index}>
                {frozen ? <MarkdownBlock content={frozen} isStreaming /> : null}
                <MarkdownBlock content={tail} isStreaming />
              </React.Fragment>
            );
          }
          return (
            <MarkdownBlock key={index} content={piece.content} isStreaming={false} />
          );
        })}
      </>
    </CitationSourcesContext.Provider>
  );
}

/**
 * Memoized: during streaming the parent re-renders ~20×/sec, but a COMPLETED
 * segment's `content` string is stable tick-to-tick (only the growing tail
 * segment changes). Skipping unchanged segments avoids re-parsing ReactMarkdown
 * and (with CodeHighlight's plain-while-streaming) keeps the view static. Deps
 * mirror the component's own useMemo inputs.
 */
export const AtlarixMarkdownSegment = memo(
  AtlarixMarkdownSegmentImpl,
  (prev, next) =>
    prev.content === next.content &&
    prev.isStreaming === next.isStreaming &&
    (prev.citationSources?.length ?? 0) === (next.citationSources?.length ?? 0),
);
