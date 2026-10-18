/**
 * DeepSeek V3.2 through Bedrock (QA 2026-10-18): every tool call ran as a real
 * call, but the opening of DeepSeek's own markup leaked into the reply once per
 * call — "…changes.\n\n<｜DSML｜function_calls" right before each tool card.
 */
import { describe, expect, it } from "vitest";
import { stripDeepSeekDsml, sanitizeMarkdownForDisplay } from "@/lib/chat/answer-display";
import { cleanFullResponse } from "@/ipc/utils/cleanFullResponse";

const card = '<atlarix-tool-call name="glob" id="t1"></atlarix-tool-call>';

describe("DeepSeek's tool-call markup", () => {
  it("goes from the stored reply while streaming, before the tool card it leaked beside", () => {
    const streamed = `Let me check git status.\n\n<｜DSML｜function_calls${card}`;
    expect(cleanFullResponse(streamed)).toBe(`Let me check git status.\n\n${card}`);
  });

  it("mid-stream, leaves a tag that may still be arriving, so its rest isn't orphaned", () => {
    expect(stripDeepSeekDsml("Checking.<｜DSML｜func", false)).toBe("Checking.<｜DSML｜func");
    expect(stripDeepSeekDsml("Checking.<｜DSML｜func")).toBe("Checking.");
  });

  it("drops whole blocks, closers and the ASCII-bar spelling", () => {
    const block =
      '<｜DSML｜function_calls>\n<｜DSML｜invoke name="grep">\n<｜DSML｜parameter name="pattern" string="true">TODO</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';
    expect(stripDeepSeekDsml(`Searching.\n${block}\nDone.`)).toBe("Searching.\n\nDone.");
    expect(stripDeepSeekDsml("a</｜DSML｜function_calls>b<|DSML|function_calls>c")).toBe("abc");
  });

  it("is gone from a reply saved before the fix, when it is shown", () => {
    expect(sanitizeMarkdownForDisplay("Reading the README.\n\n<｜DSML｜function_calls")).toBe("Reading the README.");
  });

  it("leaves everything else alone", () => {
    const text = "Use `a | b` and <div>x</div>; DSML is DeepSeek's markup.";
    expect(stripDeepSeekDsml(text)).toBe(text);
  });
});
