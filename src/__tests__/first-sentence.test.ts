import { describe, expect, it } from "vitest";
import { firstSentence } from "@/lib/text/first-sentence";

describe("firstSentence", () => {
  it("ends at the first sentence", () => {
    expect(firstSentence("Which tab to act on. More detail here.")).toBe("Which tab to act on.");
  });

  it('does not stop inside an abbreviation (it left fragments ending "(e.g.")', () => {
    expect(firstSentence('Element ref from browser_inspect (e.g. "e12"). Then more.')).toBe(
      'Element ref from browser_inspect (e.g. "e12").',
    );
    expect(firstSentence("Plain words, i.e. no regex. Next.")).toBe("Plain words, i.e. no regex.");
  });
});
