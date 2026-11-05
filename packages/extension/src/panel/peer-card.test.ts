/**
 * A message from another Atlarix session in the side panel: one row, "Message
 * from <name> (<surface>)", its text seen even when folded (owner, 2026-11-05:
 * "a blank thing"), the whole text open.
 */
import { describe, expect, it } from "vitest";
import { wrapPeerMessage, splitPeerMessages } from "@/lib/peers/peer-message";
import { peerTaskCard } from "./peer-card";

const card = (text: string) =>
  peerTaskCard(splitPeerMessages(wrapPeerMessage({ sessionId: "s", name: "ai-4b", surface: "cli", workspace: "/w" }, text))!);

describe("the side panel's peer message", () => {
  it("a short one is open, labelled with the sender and surface", () => {
    const d = card("the build is green").querySelector("details")!;
    expect(d.open).toBe(true);
    expect(d.querySelector(".tool__label")?.textContent).toBe("Message from ai-4b (CLI)");
    expect(d.querySelector(".tool__body")?.textContent).toBe("the build is green");
  });

  it("a long one is folded to its row WITH a preview, never just the label", () => {
    const long = `ai-4b:\n\n${"Phase 2 is ready for review with every test green. ".repeat(20)}\nLast line.`;
    const d = card(long).querySelector("details")!;
    expect(d.open).toBe(false);
    const preview = d.querySelector("summary .tool__preview")?.textContent ?? "";
    expect(preview.startsWith(": ai-4b: Phase 2 is ready")).toBe(true);
    expect(d.querySelector(".tool__body")?.textContent).toContain("Last line.");
  });
});
