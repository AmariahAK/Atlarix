/**
 * QA (app) #6, second half, on build C: with the finished thread right, the
 * FIRST edit's card still diffed the model's snippet at line 1. A turn's older
 * steps are drawn from the stored tool tags, whose args are the model's own
 * (the snippet). They now take the whole-file diff the thread holds for the
 * same call.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { InlineToolPartCard } from "@/components/chat/InlineToolPartCard";
import { ThreadDiffByCallIdContext } from "@/components/chat/thread-diff-context";
import { parseAssistantMessageParts } from "@/lib/chat/assistant-message-parts";
import type { ToolExpandView } from "@/lib/chat/tool-expand-view";

const OLD = "# tally\n\nCounts words. `npm test` runs the tests.\n";
const NEW = "# tally\n\nCounts the words in a text. `npm test` runs the tests.\n";
const STORED =
  '<atlarix-tool-call tool="edit_file" call="call_1" status="running">\n' +
  '{"path":"README.md","operation":"replace","old_content":"Counts words. `npm test` runs the tests.","new_content":"Counts the words in a text. `npm test` runs the tests."}\n' +
  "</atlarix-tool-call>\n" +
  '<atlarix-tool-result tool="edit_file" call="call_1" status="complete">\n' +
  '{"success":true,"message":"Successfully wrote README.md","path":"README.md","operation":"update","added":1,"removed":1}\n' +
  "</atlarix-tool-result>";

describe("an older step's write card", () => {
  it("keeps the tool call id from the stored tag", () => {
    const tool = parseAssistantMessageParts(STORED, false).find((p) => p.type === "tool");
    expect(tool).toMatchObject({ type: "tool", callId: "call_1" });
  });

  it("shows the whole-file diff the thread holds, not the snippet", async () => {
    const tool = parseAssistantMessageParts(STORED, false).find((p) => p.type === "tool")!;
    const whole: ToolExpandView = {
      kind: "diff",
      path: "README.md",
      fileName: "README.md",
      operation: "update",
      oldContent: OLD,
      newContent: NEW,
      addedCount: 1,
      removedCount: 1,
    };
    renderWithProviders(
      <ThreadDiffByCallIdContext.Provider value={new Map([["call_1", whole]])}>
        <InlineToolPartCard part={tool as never} />
      </ThreadDiffByCallIdContext.Provider>,
    );
    const header = screen.getAllByRole("button").find((b) => /Edited file/.test(b.textContent ?? ""));
    if (header && header.getAttribute("aria-expanded") !== "true") {
      await act(async () => fireEvent.click(header));
    }
    expect(screen.getByText("# tally")).toBeTruthy();
  });
});
