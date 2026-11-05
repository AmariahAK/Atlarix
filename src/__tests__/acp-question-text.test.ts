/**
 * ask_user over ACP: editors that read text get each option's description and
 * the recommended one; Atlarix's own extension gets the full question in
 * `_meta.atlarix.question`, in the wire shape an older build still reads.
 */
import { describe, expect, it } from "vitest";
import { questionMeta, questionText } from "@/cli/acp/question-text";

const items = [
  {
    question: "Which auth method?",
    header: "Auth method",
    options: [
      { label: "OAuth", description: "Sign in with GitHub", recommended: true },
      { label: "JWT" },
    ],
  },
  { question: "Which checks?", multiSelect: true, options: [{ label: "Lint" }, { label: "Tests" }] },
  { question: "Anything else?" },
];

describe("an ACP question", () => {
  it("as text: header, • label: description, the recommended mark, and multi-select said in words", () => {
    expect(questionText(items)).toBe(
      "\n\n1. [Auth method] Which auth method?\n" +
        "   • OAuth (recommended): Sign in with GitHub\n" +
        "   • JWT\n\n" +
        "2. Which checks? (pick one or more)\n" +
        "   • Lint\n" +
        "   • Tests\n\n" +
        "3. Anything else?\n\n" +
        "(Reply with your answer.)",
    );
  });

  it("one question is not numbered (as before)", () => {
    expect(questionText([{ question: "Tabs?", options: [{ label: "Tabs" }] }])).toBe(
      "\n\nTabs?\n   • Tabs\n\n(Reply with your answer.)",
    );
  });

  it("as _meta: label strings in options for older readers, the full options in choices", () => {
    expect(questionMeta(items).items[0]).toEqual({
      question: "Which auth method?",
      header: "Auth method",
      options: ["OAuth", "JWT"],
      choices: [{ label: "OAuth", description: "Sign in with GitHub", recommended: true }, { label: "JWT" }],
    });
    expect(questionMeta(items).items[1]).toMatchObject({ multiSelect: true, options: ["Lint", "Tests"] });
  });
});
