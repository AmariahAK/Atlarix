/**
 * QA (app) #2 + owner: in the light theme the diff in an approval card and an
 * Edited-file card was unreadable. Its lines are <pre>, and inside a chat
 * answer the markdown (Typography) styles reached them: a code-block box and
 * a light-grey text colour meant for a dark box, on the light background.
 * The diff opts out of prose and colours its own text.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { renderWithProviders } from "./helpers";
import { SmartDiffView } from "@/components/SmartDiffView";

describe("diff lines inside a chat answer", () => {
  it("are out of reach of the markdown styles, in the theme's text colour", () => {
    const { container } = renderWithProviders(
      <div className="prose">
        <SmartDiffView path="src/tally.js" oldContent={"a\nb\nc\n"} newContent={"a\nB\nc\n"} />
      </div>,
    );
    const root = container.querySelector(".prose > div");
    expect(root?.classList.contains("not-prose")).toBe(true);
    const lines = [...container.querySelectorAll("pre")].filter((p) => /^[aBbc]$/.test(p.textContent ?? ""));
    expect(lines.length).toBeGreaterThan(0);
    for (const pre of lines) {
      expect(pre.classList.contains("text-foreground")).toBe(true);
      expect(pre.classList.contains("bg-transparent")).toBe(true);
    }
  });
});
