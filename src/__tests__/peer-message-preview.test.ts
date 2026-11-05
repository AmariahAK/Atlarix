/**
 * A message from another session is SEEN where it lands (owner, 2026-11-05:
 * "a blank thing"): one row, "Message from <name>: <its first ~120 chars…>",
 * the whole text on expand. And a sent message names who it went to, not a
 * session id.
 */
import { describe, expect, it } from "vitest";
import { peerPreview, peerRowLabel, sentToName } from "@/lib/peers/peer-message";

describe("peerPreview", () => {
  it("a short one-line message is shown whole, with nothing to expand", () => {
    expect(peerPreview("the build is green")).toEqual({ text: "the build is green", more: false });
  });

  it("a long one is cut near 120 chars at a word, with …, and can expand", () => {
    const long = "word ".repeat(60).trim();
    const p = peerPreview(long);
    expect(p.more).toBe(true);
    expect(p.text.endsWith("…")).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(121);
    expect(p.text).not.toMatch(/ …$/);
  });

  it("lines are joined, so a short first line (\"ai-4b:\") never hides the rest", () => {
    const p = peerPreview("ai-4b:\n\nPhase 2 is ready for review.");
    expect(p.text).toBe("ai-4b: Phase 2 is ready for review.");
    expect(p.more).toBe(true); // the line breaks are worth seeing in full
  });
});

describe("peerRowLabel", () => {
  it("names the sender and where it runs; no \"contributor\"", () => {
    expect(peerRowLabel("ai-37", "cli")).toBe("Message from ai-37 (CLI)");
    expect(peerRowLabel("", "app")).toBe("Message from another session (app)");
  });
});

describe("sentToName", () => {
  it("reads the receiver's name from send_message's own result", () => {
    expect(sentToName("Sent to QA night (CLI, idle: it starts a turn with it).")).toBe("QA night");
    expect(sentToName("Sent to Release (app, busy: it reads it at its next step). Reply comes back here.")).toBe("Release");
    expect(sentToName("Delivered to Browser task. It starts when the user clicks the Atlarix icon in Browser task (…)")).toBe("Browser task");
    expect(sentToName(JSON.stringify({ success: true, text: "Sent to ai-37 (editor, idle: it starts a turn with it)." }))).toBe("ai-37");
    expect(sentToName("No session named x")).toBeNull();
    expect(sentToName(undefined)).toBeNull();
  });
});
