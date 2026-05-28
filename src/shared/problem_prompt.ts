import type { ProblemReport } from "../ipc/ipc_types";

/**
 * Creates a more concise version of the problem fix prompt for cases where
 * brevity is preferred.
 */
export function createProblemFixPrompt(problemReport: ProblemReport): string {
  return createLspFixPrompt(problemReport);
}

/** Build a self-correction prompt from LSP (or legacy TSC-shaped) problem rows. */
export function createLspFixPrompt(problemReport: ProblemReport): string {
  const { problems } = problemReport;

  if (problems.length === 0) {
    return "No language-server errors detected.";
  }

  const totalProblems = problems.length;
  let prompt = `Fix these ${totalProblems} language-server error${totalProblems === 1 ? "" : "s"}:\n\n`;

  problems.forEach((problem, index) => {
    const codeSuffix = problem.code ? ` (${problem.code})` : "";
    prompt += `${index + 1}. ${problem.file}:${problem.line}:${problem.column} - ${problem.message}${codeSuffix}\n`;
    if (problem.snippet) {
      prompt += `\`\`\`\n${problem.snippet}\n\`\`\`\n`;
    }
    prompt += "\n";
  });

  prompt += "\nPlease fix all errors in a concise way.";

  return prompt;
}
