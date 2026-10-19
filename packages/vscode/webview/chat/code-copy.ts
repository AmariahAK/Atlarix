import { button, icon } from "../ui";

/**
 * A copy button on every code block in `container`, top right (owner: a reply's
 * commands had no way to be copied but the whole reply). Called after each
 * render, which replaces the blocks, so a block never gets two.
 */
export function addCodeCopyButtons(container: HTMLElement, onCopy: (text: string) => void): void {
  for (const pre of container.querySelectorAll<HTMLPreElement>("pre")) {
    if (pre.querySelector(".code-copy")) continue;
    const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
    const copy = button("", "code-copy", () => {
      onCopy(code);
      copy.innerHTML = icon("check", 13);
      setTimeout(() => (copy.innerHTML = icon("copy", 13)), 1200);
    }, "Copy");
    copy.innerHTML = icon("copy", 13);
    pre.append(copy);
  }
}
