/**
 * v10.1: sub-agent activity displays — tool results summarize to one-line
 * status (never raw JSON envelopes or file content dumps).
 */

import { describe, expect, it } from "vitest";
import { formatToolResultPreview } from "@/lib/chat/stream-tool-display";
import { summarizeToolActivityItem } from "@/lib/chat/inline-timeline";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";

const READ_RESULT = JSON.stringify({
  success: true,
  result:
    "File: spacinsider-api/bitbucket-pipelines.yml\nLines: 1-272 (complete)\n\n1: image: amazon/aws-cli\n2: definitions:\n3:   .auth-oidc: &auth-oidc |",
});

function activityItem(overrides: Partial<ActivityStreamItem>): ActivityStreamItem {
  return {
    id: "act-1",
    type: "tool_use",
    label: "Reading files…",
    status: "done",
    timestamp: 1,
    ...overrides,
  } as ActivityStreamItem;
}

describe("read_file result previews", () => {
  it("summarizes to a one-line status, not file content", () => {
    const preview = formatToolResultPreview("read_file", READ_RESULT, "done");
    expect(preview).toBe(
      "Read spacinsider-api/bitbucket-pipelines.yml — lines 1-272 (complete)",
    );
    expect(preview).not.toContain("amazon/aws-cli");
  });

  it("handles the head-tail truncated header", () => {
    const result = JSON.stringify({
      success: true,
      result:
        "File: spacinsider-api/web/api/mcp/mount.py\nTotal lines: 262 | Showing: 60 (head-tail)\n1: \"\"\"M…",
    });
    expect(formatToolResultPreview("read_file", result, "done")).toBe(
      "Read spacinsider-api/web/api/mcp/mount.py — 262 lines (showing 60)",
    );
  });
});

describe("summarizeToolActivityItem with raw JSON detail", () => {
  it("never pastes the JSON envelope into the summary", () => {
    const summary = summarizeToolActivityItem(
      activityItem({ toolName: "read_file", detail: READ_RESULT }),
    );
    expect(summary).toBe(
      "Read spacinsider-api/bitbucket-pipelines.yml — lines 1-272 (complete)",
    );
    expect(summary).not.toContain('{"success"');
  });

  it("plain path details keep the existing concise form", () => {
    const summary = summarizeToolActivityItem(
      activityItem({ toolName: "read_file", detail: "src/auth.ts L10-42" }),
    );
    expect(summary).toBe("Read src/auth.ts L10–42");
  });
});
