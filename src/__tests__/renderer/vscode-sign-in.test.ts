/**
 * The VS Code panel's first screen when nobody is signed in
 * (packages/vscode/webview/views/sign-in.ts): the app's ways in, not a small
 * "Sign in to Atlarix to start. [Sign in]" bar over a chat (owner, 2026-10-24).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderSignIn } from "../../../packages/vscode/webview/views/sign-in";

function mount(view: Parameters<typeof renderSignIn>[1]) {
  const root = document.createElement("div");
  const act = { choose: vi.fn(), back: vi.fn(), openUrl: vi.fn() };
  renderSignIn(root, view, act, "15.11.1");
  return { root, act };
}

describe("the panel's sign-in screen", () => {
  it("welcomes, and offers GitHub, Google, Discord, email, then a code", () => {
    const { root } = mount({ kind: "choices" });
    expect(root.textContent).toContain("Welcome to Atlarix");
    expect(
      [...root.querySelectorAll<HTMLButtonElement>(".signin__choice")].map(
        (b) => b.querySelector(".signin__label")?.textContent,
      ),
    ).toEqual([
      "Continue with GitHub",
      "Continue with Google",
      "Continue with Discord",
      "Continue with email",
      "Sign in with a code",
    ]);
  });

  it("each choice starts its own way in", () => {
    const { root, act } = mount({ kind: "choices" });
    root.querySelector<HTMLButtonElement>('[data-choice="discord"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-choice="code"]')!.click();
    expect(act.choose.mock.calls).toEqual([["discord"], ["code"]]);
  });

  it("shows the code to enter, and where", () => {
    const { root, act } = mount({
      kind: "code",
      userCode: "ABCD-1234",
      verificationUri: "https://atlarix.dev/auth/cli",
      expiresInS: 600,
    });
    expect(root.querySelector(".signin__code")?.textContent).toBe("ABCD-1234");
    expect(root.textContent).toContain("10 minutes");
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "https://atlarix.dev/auth/cli")!
      .click();
    expect(act.openUrl).toHaveBeenCalledWith("https://atlarix.dev/auth/cli");
  });

  it("a failed sign-in says why, with the choices again", () => {
    const { root } = mount({ kind: "choices", error: "Sign-in timed out." });
    expect(root.querySelector(".signin__error")?.textContent).toBe(
      "Sign-in timed out.",
    );
    expect(root.querySelectorAll(".signin__choice")).toHaveLength(5);
  });

  it("signed out, it is the whole panel: chat and message box hidden", () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, "../../../packages/vscode/webview/style.css"),
      "utf8",
    );
    expect(css).toMatch(
      /#app\.signed-out > :not\(\.signin-screen\):not\(\.toast-slot\)\s*\{\s*display: none !important;/,
    );
  });
});
