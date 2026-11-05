/**
 * A message from another session in the VS Code panel
 * (packages/vscode/webview/chat/transcript.ts): "Message from <name> (<surface>)"
 * with its text seen, a long one as a preview that expands (owner: "a blank thing").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: () => {} });
});

import { initTranscript, log, toolCall } from "../../../packages/vscode/webview/chat/transcript";

beforeEach(() => {
  log.replaceChildren();
  document.body.replaceChildren(log);
  initTranscript({ goBack: vi.fn(), answer: vi.fn(), restore: vi.fn() });
});

const peerCall = (id: string, text: string, peer: Record<string, string>) =>
  toolCall({
    toolCallId: id,
    title: "Message …",
    status: "completed",
    _meta: { atlarix: { peer } },
    content: [{ type: "content", content: { type: "text", text } }],
  } as never);

describe("a peer message in VS Code", () => {
  it("names the sender and surface, no \"contributor\", and shows a short text whole", () => {
    peerCall("1:p0", "the build is green", { from: "QA", surface: "app" });
    const card = log.querySelector<HTMLElement>(".card.peer")!;
    expect(card.querySelector(".peer__head")?.textContent).toBe("Message from QA (app)");
    expect(card.querySelector(".peer__text")?.textContent).toBe("the build is green");
    expect(card.querySelector(".peer__more")).toBeNull();
  });

  it("an older CLI's meta (no surface) still reads, by name", () => {
    peerCall("2:p0", "hi", { from: "QA" });
    expect(log.querySelector(".peer__head")?.textContent).toBe("Message from QA");
  });

  it("a long one shows a preview and expands to all of it", () => {
    const long = `ai-4b:\n\n${"Phase 2 is ready for review with every test green. ".repeat(20)}\nLast line.`;
    peerCall("3:p0", long, { from: "ai-4b", surface: "cli" });
    const card = log.querySelector<HTMLElement>(".card.peer")!;
    const body = card.querySelector<HTMLElement>(".peer__text")!;
    expect(body.textContent!.startsWith("ai-4b: Phase 2 is ready")).toBe(true);
    expect(body.textContent).not.toContain("Last line.");
    card.querySelector<HTMLButtonElement>(".peer__more")!.click();
    expect(card.querySelector<HTMLElement>(".peer__text")!.textContent).toContain("Last line.");
    expect(card.querySelector(".peer__more")).toBeNull();
  });
});
