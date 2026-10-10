import { describe, expect, it } from "vitest";
import { ASK_AFTER_TURNS, noteTurn, ratingUrl, type RatingState } from "../../packages/vscode/src/rating";

describe("the editor extension asks for a rating once", () => {
  it("asks at the fifth finished turn, and never again", () => {
    let state: RatingState = { turns: 0, asked: false };
    const asks: number[] = [];
    for (let i = 1; i <= 20; i++) {
      const r = noteTurn(state);
      state = r.state;
      if (r.ask) asks.push(i);
    }
    expect(asks).toEqual([ASK_AFTER_TURNS]);
    expect(state.asked).toBe(true);
  });

  it("sends VS Code to the Marketplace and the other editors to Open VSX", () => {
    expect(ratingUrl("Visual Studio Code")).toContain("marketplace.visualstudio.com");
    expect(ratingUrl("Visual Studio Code - Insiders")).toContain("marketplace.visualstudio.com");
    for (const app of ["Cursor", "Kiro", "Windsurf", "VSCodium"]) expect(ratingUrl(app)).toContain("open-vsx.org");
  });
});
