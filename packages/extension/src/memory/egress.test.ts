/**
 * The copy detector.
 *
 * Two failure directions, and they are not symmetric. A FALSE NEGATIVE lets
 * page content sync to a server that promised never to hold any. A FALSE
 * POSITIVE refuses a legitimate note and the model, told why, rewrites it in its
 * own words — which is the behaviour we wanted anyway. So the tests lean on
 * catching the paste, and only require that ordinary prose about a person
 * survives.
 */

import { describe, expect, it } from "vitest";
import { MIN_VERBATIM_RUN, looksCopiedFromPage } from "./egress";

const PAGE =
  "The tardigrade is a microscopic animal that can survive extreme conditions " +
  "including desiccation, radiation and the vacuum of space, which makes it " +
  "one of the most resilient known organisms on earth.";

describe("catching a paste", () => {
  it("catches the body copied straight out of a tool result", () => {
    const v = looksCopiedFromPage(PAGE, [PAGE]);
    expect(v.copied).toBe(true);
  });

  it("catches it when it has been reformatted", () => {
    // Punctuation dropped, case folded, whitespace collapsed — so a paste that
    // went through a markdown bullet list is still the same words.
    const reformatted =
      "- the TARDIGRADE is a microscopic animal that can survive extreme " +
      "conditions   including desiccation radiation and the vacuum of space " +
      "which makes it one of the most resilient known organisms on earth";
    expect(looksCopiedFromPage(reformatted, [PAGE]).copied).toBe(true);
  });

  it("catches a paste buried inside an otherwise genuine note", () => {
    const body = `They care about this topic.\n\n${PAGE}\n\nAsk again next week.`;
    expect(looksCopiedFromPage(body, [PAGE]).copied).toBe(true);
  });

  it("checks EVERY tool result, not just the most recent", () => {
    expect(looksCopiedFromPage(PAGE, ["something else", PAGE]).copied).toBe(
      true,
    );
  });

  it("reports the overlap, so the refusal can quote it", () => {
    const v = looksCopiedFromPage(PAGE, [PAGE]);
    if (!v.copied) throw new Error("expected copied");
    expect(v.overlap.split(/\s+/).length).toBe(MIN_VERBATIM_RUN);
  });
});

describe("leaving real notes alone", () => {
  it("allows a paraphrase, which is the whole point of the rule", () => {
    // "The Pro plan is $19 a month" is the answer the user wanted; where it was
    // written is incidental. A detector that blocked this would be wrong.
    const note = "They looked up tardigrades and were impressed by how tough they are.";
    expect(looksCopiedFromPage(note, [PAGE]).copied).toBe(false);
  });

  it("allows a short quotation", () => {
    // Under the run threshold on purpose: quoting a phrase is not exporting a
    // page, and refusing it would make the feature annoying enough to route
    // around.
    expect(
      looksCopiedFromPage(
        'They liked the phrase "the vacuum of space" from that article.',
        [PAGE],
      ).copied,
    ).toBe(false);
  });

  it("allows a note written with nothing read this turn", () => {
    expect(looksCopiedFromPage(PAGE, []).copied).toBe(false);
  });

  it("allows a note too short to contain a long run", () => {
    expect(looksCopiedFromPage("Prefers metric.", [PAGE]).copied).toBe(false);
  });
});

describe("scripts other than Latin", () => {
  it("still tokenises a language that does not use the Latin alphabet", () => {
    // AN ASCII `\\w` WOULD STRIP EVERY CHARACTER HERE, yielding an empty word
    // list, reading as "no overlap", and silently disabling the check for
    // exactly the users least likely to report it. `\\p{L}\\p{N}` is not
    // optional — the same trap is recorded against the sanitiser in the TODO.
    const japanese =
      "クマムシ は 極限 環境 で 生き延びる こと が できる 微小 な 動物 で あり " +
      "乾燥 放射線 そして 宇宙 の 真空 に も 耐える こと が 知られて いる 生物 です";
    expect(looksCopiedFromPage(japanese, [japanese]).copied).toBe(true);
  });
});
