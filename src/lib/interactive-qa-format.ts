/**
 * Shared Markdown formatting for interactive question answers shown as user bubbles.
 */

export function formatInteractiveQaLine(
  question: string,
  answer: string,
): string {
  const q = String(question ?? "").trim();
  const a = String(answer ?? "").trim();
  return `***Q:*** ${q} → ***A:*** ${a}`;
}

/**
 * The answers in a stored answers row, as question/answer pairs, for display.
 * One question is stored as `***Q:*** q → ***A:*** a`; several as
 * `***Q:*** N questions → ***A:*** Q: q1\nA: a1\n\nQ: q2\nA: a2`. Null when the
 * text isn't an answers row. The stored text (what the model reads) stays.
 */
export function parseQaAnswers(
  content: string,
): Array<{ q: string; a: string }> | null {
  const m = /^\*\*\*Q:\*\*\* ([\s\S]*?) → \*\*\*A:\*\*\* ([\s\S]*)$/.exec(
    content.trim(),
  );
  if (!m) return null;
  const [, question, answer] = m;
  if (/^\d+ questions$/.test(question!.trim())) {
    const pairs = answer!
      .split(/\n\s*\n/)
      .map((block) => /^Q:\s*([\s\S]*?)\nA:\s*([\s\S]*)$/.exec(block.trim()))
      .filter((p): p is RegExpExecArray => p != null)
      .map((p) => ({ q: p[1]!.trim(), a: p[2]!.trim() }));
    if (pairs.length) return pairs;
  }
  return [{ q: question!.trim(), a: answer!.trim() }];
}
