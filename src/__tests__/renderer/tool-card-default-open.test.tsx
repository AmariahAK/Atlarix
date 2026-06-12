/**
 * v13 Phase 5: completed mutating tools show their meaningful detail by
 * DEFAULT — diff for writes/edits, output + exit code for commands. Reads
 * stay collapsed. Running cards never mount expand content.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { StreamToolCallCard } from "@/components/chat/StreamToolCallCard";
import { defaultOpenFor } from "@/lib/chat/tool-expand-view";

describe("tool card default-open (v13)", () => {
  it("a done command card shows its output and exit code without a click", () => {
    renderWithProviders(
      <StreamToolCallCard
        summary="Ran npm test"
        status="done"
        toolName="run_command"
        expand={{
          kind: "command",
          command: "npm test",
          exitCode: 0,
          body: "all 12 tests passed",
        }}
      />,
    );
    expect(screen.getByText("all 12 tests passed")).toBeInTheDocument();
    expect(screen.getByText("exit 0")).toBeInTheDocument();
  });

  it("a done diff card shows the diff without a click", () => {
    renderWithProviders(
      <StreamToolCallCard
        summary="Edited src/auth.ts"
        status="done"
        toolName="edit_file"
        expand={{
          kind: "diff",
          path: "src/auth.ts",
          fileName: "auth.ts",
          operation: "update",
          oldContent: "const a = 1;",
          newContent: "const a = 2;",
          addedCount: 1,
          removedCount: 1,
        }}
      />,
    );
    // SmartDiffView mounts (the new content is visible by default).
    expect(screen.getByText(/const a = 2;/)).toBeInTheDocument();
  });

  it("a done read card stays collapsed behind the chevron", () => {
    renderWithProviders(
      <StreamToolCallCard
        summary="Read src/main.ts"
        status="done"
        toolName="read_file"
        expand={{
          kind: "read_snippet",
          path: "src/main.ts",
          fileName: "main.ts",
          directory: "src",
          snippet: "export const main = 1;",
        }}
      />,
    );
    expect(screen.queryByText("export const main = 1;")).not.toBeInTheDocument();
  });

  it("running cards never mount expand content", () => {
    renderWithProviders(
      <StreamToolCallCard
        summary="Running npm test"
        status="running"
        toolName="run_command"
        expand={{ kind: "command", body: "partial output" }}
      />,
    );
    expect(screen.queryByText("partial output")).not.toBeInTheDocument();
  });

  it("defaultOpenFor is shared logic: diff/command/error open, reads stay shut", () => {
    expect(defaultOpenFor({ kind: "command", body: "x" }, "done")).toBe(true);
    expect(
      defaultOpenFor(
        {
          kind: "diff",
          path: "a",
          fileName: "a",
          operation: "update",
          oldContent: "",
          newContent: "x",
        },
        "done",
      ),
    ).toBe(true);
    expect(defaultOpenFor({ kind: "text", body: "x" }, "done")).toBe(false);
    expect(defaultOpenFor({ kind: "command", body: "x" }, "running")).toBe(false);
    expect(defaultOpenFor({ kind: "none" }, "error")).toBe(true);
  });
});
