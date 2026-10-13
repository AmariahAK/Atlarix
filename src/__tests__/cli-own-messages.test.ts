import { describe, expect, it } from "vitest";
import { ownMessages } from "@/cli/agent/own-messages";

const peer = (from: string, text: string) =>
  `<atlarix-peer-message from="${from}" reply-to="s9" surface="app" workspace="/w">${text}</atlarix-peer-message>`;

describe("what you can go back to (/undo, esc esc, the editor)", () => {
  it("never a teammate's message; only your own words in a mixed row", () => {
    const list = ownMessages([
      { id: 1, role: "user", content: "fix the login bug" },
      { id: 2, role: "assistant", content: "Done." },
      { id: 3, role: "user", content: peer("Release prep", "Please don't touch package.json") },
      { id: 4, role: "assistant", content: "Noted." },
      { id: 5, role: "user", content: `${peer("Docs", "FYI the README moved")}\n\nand add a test` },
      { id: 6, role: "user", content: "***Q:*** Which DB? → ***A:*** SQLite" },
    ]);
    expect(list).toEqual([
      { id: 5, text: "and add a test" },
      { id: 1, text: "fix the login bug" },
    ]);
  });
});
