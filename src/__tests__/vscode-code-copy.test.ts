// @vitest-environment jsdom
/**
 * The editor panel's code blocks each get a copy button (owner, 2026-10-19:
 * "no copy button on ide"), copying the code alone, never the button.
 */
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../packages/extension/src/panel/markdown";
import { addCodeCopyButtons } from "../../packages/vscode/webview/chat/code-copy";

const reply = [
  "How to test it locally",
  "",
  "```",
  "bun install",
  "bun run typecheck && bun run lint && bun test   # expect 53 pass",
  "bun start",
  "```",
  "",
  "- a step",
  "  ```sh",
  "  echo nested",
  "  ```",
].join("\n");

describe("code block copy", () => {
  it("puts one button on each code block and copies its code exactly", () => {
    const body = document.createElement("div");
    renderMarkdown(body, reply);
    const copied: string[] = [];
    addCodeCopyButtons(body, (t) => copied.push(t));
    const buttons = body.querySelectorAll<HTMLButtonElement>("pre .code-copy");
    expect(buttons.length).toBe(body.querySelectorAll("pre").length);
    buttons[0]!.click();
    expect(copied[0]).toBe("bun install\nbun run typecheck && bun run lint && bun test   # expect 53 pass\nbun start");
  });

  it("never adds a second button to a block that has one", () => {
    const body = document.createElement("div");
    renderMarkdown(body, reply);
    addCodeCopyButtons(body, () => {});
    addCodeCopyButtons(body, () => {});
    for (const pre of body.querySelectorAll("pre")) expect(pre.querySelectorAll(".code-copy").length).toBe(1);
  });
});
