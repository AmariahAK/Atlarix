import { afterEach, describe, expect, it } from "vitest";
import {
  clearBrowserRecording,
  formatBrowserRecordingArtifact,
  getBrowserRecording,
  recordBrowserAction,
} from "@/lib/tools/browser-recorder";

const CHAT = 4242;

describe("browser session recorder (verifiable artifact)", () => {
  afterEach(() => clearBrowserRecording(CHAT));

  it("records actions in order and renders a reviewable walkthrough", () => {
    recordBrowserAction(
      CHAT,
      "navigate",
      "https://app.test/login",
      "https://app.test/login",
    );
    recordBrowserAction(
      CHAT,
      "fill",
      'input#email = "a@b.com"',
      "https://app.test/login",
    );
    recordBrowserAction(
      CHAT,
      "click",
      "button[type=submit]",
      "https://app.test/login",
    );
    recordBrowserAction(
      CHAT,
      "screenshot",
      "viewport @ app.test",
      "https://app.test/home",
    );

    const steps = getBrowserRecording(CHAT);
    expect(steps.map((s) => s.type)).toEqual([
      "navigate",
      "fill",
      "click",
      "screenshot",
    ]);

    const art = formatBrowserRecordingArtifact(CHAT)!;
    expect(art).toContain("Browser session walkthrough (4 steps)");
    expect(art).toContain("1. **navigate** — https://app.test/login");
    expect(art).toContain("3. **click** — button[type=submit]");
  });

  it("is null/empty and a no-op without a chat id", () => {
    expect(formatBrowserRecordingArtifact(CHAT)).toBeNull();
    recordBrowserAction(undefined, "click", "x");
    expect(getBrowserRecording(undefined)).toEqual([]);
  });

  it("isolates recordings per chat", () => {
    recordBrowserAction(CHAT, "navigate", "https://a", "https://a");
    recordBrowserAction(99, "navigate", "https://b", "https://b");
    expect(getBrowserRecording(CHAT)).toHaveLength(1);
    expect(getBrowserRecording(99)).toHaveLength(1);
    expect(getBrowserRecording(CHAT)[0]!.detail).toBe("https://a");
    clearBrowserRecording(99);
  });
});
