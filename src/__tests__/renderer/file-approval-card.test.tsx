/**
 * QA (app) #7 at 960x700: Deny came after three "Always allow" buttons and
 * wrapped below the fold; the card's title "2 edits" said again what the
 * diff shows, and its Summary box a third time; the diff opened with the raw
 * "--- src/tally.js → +++ src/tally.js".
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { FilePermissionCard } from "@/components/chat/InlinePermissionApprovals";

const noop = () => {};

describe("a file approval card", () => {
  it("puts Deny beside Allow once, titles the file, and drops the repeats", () => {
    const { container } = renderWithProviders(
      <FilePermissionCard
        operation={{
          id: "op-1",
          operation: "edit_file",
          status: "pending",
          timestamp: 0,
          path: "src/tally.js",
          oldContent: "a\nb\n",
          content: "a\nB\n",
          description: "2 edits",
          fileParentDir: "src",
          fileExtension: ".js",
        } as never}
        appId={39}
        onOnce={noop}
        onAlwaysFile={noop}
        onAlwaysDirectory={noop}
        onAlwaysExtension={noop}
        onDeny={noop}
      />,
    );
    const labels = screen.getAllByRole("button").map((b) => b.textContent?.trim()).filter((t) => /Allow|Deny/.test(t ?? ""));
    expect(labels.slice(0, 2)).toEqual(["Allow once", "Deny"]);
    expect(screen.getAllByText("src/tally.js").length).toBeGreaterThan(0);
    expect(screen.queryByText("Summary")).toBeNull();
    expect(container.textContent).not.toContain("→  +++");
  });
});
