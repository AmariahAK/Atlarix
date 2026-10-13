import { Fragment, type ReactNode } from "react";

/**
 * One line of model text with its inline marks drawn — `code` and **bold** —
 * for places that show a line, not a block (a plan step, a question). Drawn as
 * plain text, "**`src/tally.js`** — add a `minLength`" showed its stars and
 * backticks (QA #34, #36).
 */
export function InlineMarkdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /(\*\*|__)(.+?)\1|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[3] != null) {
      out.push(
        <code key={i++} className="rounded bg-muted/60 px-1 py-px font-mono text-[0.9em]">
          {m[3]}
        </code>,
      );
    } else {
      out.push(
        <strong key={i++} className="font-semibold">
          <InlineMarkdown text={m[2]!} />
        </strong>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <Fragment>{out}</Fragment>;
}
