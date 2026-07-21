/**
 * Renders a markdown segment that may contain atlarix-write / read / output tags
 * but not tool or thought tags (those are handled by AssistantMessageBody).
 */
import React, { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripPartialQuestionsBlockForDisplay } from "@/ipc/utils/cleanFullResponse";
import { fenceDelimiter, sanitizeMarkdownForDisplay } from "@/lib/chat/answer-display";
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
 * inside an open code fence and (b) not between the lines of a list/table/
 * blockquote. During streaming the frozen prefix is byte-identical flush-to-
 * flush, so MarkdownBlock's memo skips re-parsing it — the O(len)×20Hz whole-
 * answer re-parse collapses to O(tail). `sanitizeMarkdownForDisplay` has already
 * collapsed paragraph `\n\n` to single `\n` upstream, so we cut on `\n`. Returns
 * tail-only (empty frozen) when no safe cut exists yet — correctness over perf.
 *
 * Fence detection is a real per-line CommonMark tracker (an opening fence of N
 * `\`` / `~` closes only on a later same-char line of ≥N with no info string):
 * the old `/\`\`\`/g` substring parity mis-counted a fence delimiter appearing
 * INSIDE a code block's body (e.g. an agent explaining markdown), flipping
 * parity for every later block and cutting mid-fence — which spilled the code
 * body out of its box as plain text.
 */
export function splitFrozenTail(content: string): { frozen: string; tail: string } {
  const lines = content.split("\n");
  // closedBeforeLine[i] === true ⇒ no fence is open where line i begins, i.e.
  // the newline *before* line i is a fence-safe cut boundary.
  const closedBeforeLine: boolean[] = [];
  // Offset (in `content`) of the newline that precedes line i, for i ≥ 1.
  const newlineBeforeLine: number[] = [];
  let open: { char: string; len: number } | null = null;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    closedBeforeLine.push(open === null);
    newlineBeforeLine.push(offset - 1); // the '\n' terminating line i-1
    const d = fenceDelimiter(lines[i] as string);
    if (d) {
      if (open === null) {
        open = { char: d.char, len: d.len };
      } else if (d.info === "" && d.char === open.char && d.len >= open.len) {
        open = null;
      }
      // A fence-looking line inside an open fence (different char, shorter, or
      // with an info string) is CONTENT — leave the fence open.
    }
    offset += (lines[i] as string).length + 1; // +1 for the '\n'
  }

  for (let i = lines.length - 1; i >= 1; i--) {
    if (!closedBeforeLine[i]) continue; // fence open at this boundary — unsafe
    const prevLine = lines[i - 1] as string;
    const nextLine = lines[i] as string;
    // Unsafe ONLY when the cut falls BETWEEN two continuation lines (i.e. inside
    // a list/table/blockquote). Cutting before a construct starts, or after one
    // ends, leaves the construct whole in a single block — that's fine.
    if (isBlockContinuationLine(prevLine) && isBlockContinuationLine(nextLine)) {
      continue;
    }
    const cut = newlineBeforeLine[i] as number;
    if (cut <= 0) break; // no room for a non-empty frozen prefix
    return { frozen: content.slice(0, cut), tail: content.slice(cut) };
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
                {frozen ? (
                  <MarkdownBlock key="frozen" content={frozen} isStreaming />
                ) : null}
                <MarkdownBlock key="tail" content={tail} isStreaming />
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
