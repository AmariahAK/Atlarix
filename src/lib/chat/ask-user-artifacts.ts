/**
 * ask_user question artifacts (v11.1 end-turn redesign).
 *
 * When the model asks questions, the TURN ENDS — no blocking wait, no 30-min
 * timeout. The pending questions are persisted inside the assistant message
 * content as an HTML-comment marker (same convention as `atlarix-plan` /
 * `<atlarix-sources>`), so the inline question card survives app reloads.
 * The user's answers come back as a real user message (Q → A transcript) and
 * a fresh stream continues the task.
 *
 * Pure string helpers — safe in both main and renderer.
 */

export type AskUserArtifactQuestion = {
  question: string;
  options?: string[];
};

export type AskUserArtifact = {
  questionId: string;
  questions: AskUserArtifactQuestion[];
};

const QUESTIONS_COMMENT_RE = /<!--\s*atlarix-questions:\s*([\s\S]*?)\s*-->/i;
const QUESTIONS_COMMENT_RE_ALL = /<!--\s*atlarix-questions:\s*[\s\S]*?\s*-->/gi;

/** Append the pending-questions marker to assistant content before persist. */
export function appendQuestionsArtifact(
  content: string,
  artifact: AskUserArtifact,
): string {
  const marker = `<!-- atlarix-questions:${JSON.stringify(artifact)} -->`;
  const base = content.trimEnd();
  return base ? `${base}\n\n${marker}\n` : `${marker}\n`;
}

/** Extract the (last) questions marker from persisted assistant content. */
export function extractQuestionsArtifact(
  content: string | null | undefined,
): AskUserArtifact | null {
  if (!content || !content.includes("atlarix-questions:")) return null;
  const matches = content.match(QUESTIONS_COMMENT_RE_ALL);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const inner = last.match(QUESTIONS_COMMENT_RE)?.[1];
  if (!inner) return null;
  try {
    const parsed = JSON.parse(inner) as AskUserArtifact;
    if (
      !parsed ||
      typeof parsed.questionId !== "string" ||
      !Array.isArray(parsed.questions) ||
      parsed.questions.length === 0
    ) {
      return null;
    }
    const questions = parsed.questions
      .filter((q) => q && typeof q.question === "string" && q.question.trim())
      .map((q) => ({
        question: q.question,
        ...(Array.isArray(q.options) && q.options.length > 0
          ? { options: q.options.map(String) }
          : {}),
      }));
    if (questions.length === 0) return null;
    return { questionId: parsed.questionId, questions };
  } catch {
    return null;
  }
}

/** Remove the marker for display (the card renders separately). */
export function stripQuestionsArtifactForDisplay(content: string): string {
  if (!content || !content.includes("atlarix-questions:")) return content;
  return content.replace(QUESTIONS_COMMENT_RE_ALL, "").trimEnd();
}
