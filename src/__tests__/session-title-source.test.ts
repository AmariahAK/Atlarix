/**
 * A generated session title follows the prompt it came from; a typed one never
 * changes.
 *
 * THE BUG: re-titling was gated on the title still being a DEFAULT ("Untitled" /
 * "New chat") in both `workspace_session_handlers` and
 * `workspace-session-title`. So the moment a session had ANY name — including
 * one we generated ourselves from its first exchange — editing that first prompt
 * could never update it. The session kept a name describing a question the user
 * had already replaced.
 *
 * The gate is now OWNERSHIP (`titleSource`), and the regeneration guard lives in
 * shared module state so the composer can reopen it when the first prompt — and
 * only the first prompt — is edited.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  allowRetitleAfterFirstPromptEdit,
  markTitleGenerated,
  needsGeneratedTitle,
} from "@/lib/workspace-session-title";

const CHAT = -101;
const OTHER_CHAT = -102;

describe("session re-title guard", () => {
  beforeEach(() => {
    // The set is module state; reset both ids used here.
    allowRetitleAfterFirstPromptEdit(CHAT);
    allowRetitleAfterFirstPromptEdit(OTHER_CHAT);
  });

  it("generates once for a new chat", () => {
    expect(needsGeneratedTitle(CHAT)).toBe(true);
    markTitleGenerated(CHAT);
    expect(needsGeneratedTitle(CHAT)).toBe(false);
  });

  it("does not regenerate on every later turn", () => {
    markTitleGenerated(CHAT);
    expect(needsGeneratedTitle(CHAT)).toBe(false);
    expect(needsGeneratedTitle(CHAT)).toBe(false);
  });

  it("REGRESSION: editing the first prompt reopens generation", () => {
    markTitleGenerated(CHAT);
    allowRetitleAfterFirstPromptEdit(CHAT);
    expect(needsGeneratedTitle(CHAT)).toBe(true);
  });

  it("reopening one chat does not affect another", () => {
    markTitleGenerated(CHAT);
    markTitleGenerated(OTHER_CHAT);
    allowRetitleAfterFirstPromptEdit(CHAT);
    expect(needsGeneratedTitle(CHAT)).toBe(true);
    expect(needsGeneratedTitle(OTHER_CHAT)).toBe(false);
  });
});
