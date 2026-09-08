/**
 * A failed turn must still name its session.
 *
 * THE BUG THIS GUARDS. Title generation needs an assistant reply to summarise, so a turn
 * that errored produces no title — while the user's message has already persisted. That
 * leaves the session with messages AND a default title, which is the one state that is
 * neither nameable nor reusable: `pickSessionReuse` only reuses a session with zero
 * messages, so the next "New chat" makes another "Untitled". Two failures, two stranded
 * sessions, observed 2026-09-08.
 *
 * These cover the deterministic half only. It takes no model call, so unlike generation
 * it cannot fail for the reason that got us here.
 */
import { describe, expect, it } from "vitest";
import { summariseFirstPrompt } from "@/lib/workspace-session-title";

describe("summariseFirstPrompt", () => {
  it("names a session from the first line of the prompt", () => {
    expect(summariseFirstPrompt("hey how are you?")).toBe("hey how are you?");
  });

  it("takes the FIRST non-empty line, not the first N characters", () => {
    // Attachments and pasted blocks ride along in the message. The opening of a
    // 400-line paste is a worse name than the sentence the user actually typed.
    const prompt = "\n\nfix the login bug\n\nconst a = 1;\nconst b = 2;\n";
    expect(summariseFirstPrompt(prompt)).toBe("fix the login bug");
  });

  it("collapses whitespace so a wrapped prompt does not become a ragged title", () => {
    expect(summariseFirstPrompt("  add   15    new quotes  ")).toBe("add 15 new quotes");
  });

  it("truncates on a boundary and marks it, rather than cutting mid-title", () => {
    const long = "a".repeat(80);
    const out = summariseFirstPrompt(long)!;
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns null when there is nothing nameable", () => {
    // The real case the AI path also hits: a session opened by pasting whitespace.
    expect(summariseFirstPrompt("")).toBeNull();
    expect(summariseFirstPrompt("   \n\n  \t ")).toBeNull();
  });

  it("refuses to name a session after a DEFAULT title", () => {
    // Otherwise "Untitled" typed as a prompt would set the title to "Untitled" and
    // report success, burning the fallback and leaving the session looking unnamed.
    expect(summariseFirstPrompt("Untitled")).toBeNull();
  });
});
