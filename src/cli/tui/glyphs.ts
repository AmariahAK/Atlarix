/**
 * Atlarix's own transcript marks, built on the ◆ logo and the rounded box
 * corners (not another tool's ● / ⎿ / ✻). One table, used by the transcript
 * and the task view alike.
 */
export const glyph = {
  /** Atlarix speaking. */
  reply: "◆",
  /** Thinking. */
  thought: "∴",
  /** You. */
  prompt: "›",
  /** A question Atlarix asked you; your answer follows it. */
  question: "?",
  /** A tool call's result, under it. */
  result: "╰",
  /** A sub-agent's own calls, under its task. */
  child: "├",
  tool: {
    running: "◌",
    success: "◇",
    error: "✕",
    interrupted: "◻",
  },
} as const;
