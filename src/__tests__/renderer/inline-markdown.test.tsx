/**
 * QA (app) #34: plan steps showed "**`src/tally.js`** — add a `minLength`…"
 * with their stars and backticks. A step's inline marks are drawn.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { InlineMarkdown } from "@/components/chat/InlineMarkdown";

describe("a plan step's inline marks", () => {
  it("draws bold and code, not their marks", () => {
    const { container } = render(<InlineMarkdown text={"**`src/tally.js`** — add a `minLength` option"} />);
    expect(container.textContent).toBe("src/tally.js — add a minLength option");
    expect(container.querySelector("strong code")?.textContent).toBe("src/tally.js");
    expect(container.querySelectorAll("code")).toHaveLength(2);
  });
});
