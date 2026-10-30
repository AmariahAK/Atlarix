/**
 * The rating prompt takes a digit only from an empty composer, and steps aside
 * once the person types (QA 2026-10-30: every "1" in a typed message was eaten).
 */
import { describe, expect, it } from "vitest";
import { ratingAnswerFor, ratingSnoozesOn } from "../cli/tui/rating-keys";

describe("rating keys", () => {
  it("a digit on an empty composer answers", () => {
    expect(ratingAnswerFor({ name: "1" }, { asking: true, composerText: "" })).toBe("1");
    expect(ratingAnswerFor({ name: "0" }, { asking: true, composerText: "" })).toBe("0");
  });
  it("a digit inside what is being typed is text, not an answer", () => {
    expect(ratingAnswerFor({ name: "1" }, { asking: true, composerText: "Use edit_file to create /tmp/claude-50" })).toBeNull();
  });
  it("nothing when the prompt is not showing, or with a modifier", () => {
    expect(ratingAnswerFor({ name: "2" }, { asking: false, composerText: "" })).toBeNull();
    expect(ratingAnswerFor({ name: "2", ctrl: true }, { asking: true, composerText: "" })).toBeNull();
  });
  it("the first ordinary key snoozes the prompt; answers and navigation do not", () => {
    expect(ratingSnoozesOn({ name: "u", sequence: "u" })).toBe(true);
    expect(ratingSnoozesOn({ name: "space" })).toBe(true);
    expect(ratingSnoozesOn({ name: "1", sequence: "1" })).toBe(false);
    expect(ratingSnoozesOn({ name: "escape" })).toBe(false);
    expect(ratingSnoozesOn({ name: "c", ctrl: true })).toBe(false);
  });
});
