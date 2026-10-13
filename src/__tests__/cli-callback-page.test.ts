import { describe, expect, it } from "vitest";
import { callbackPage } from "@/cli/auth/browser-sign-in";

describe("the browser's sign-in page (127.0.0.1/callback)", () => {
  it("names where to go back to: the editor when an editor asked", () => {
    const page = callbackPage("your editor");
    expect(page).toContain("Go back to your editor. You can close this tab.");
    expect(page).not.toContain("the terminal");
    expect(page).toContain('class="rix');
    // It reads the CLI's exact success line to show the email.
    expect(page).toContain("/^Signed in as (.+)$/");
  });
  it("cannot be made to show markup through the return-to name", () => {
    expect(callbackPage('<img src=x onerror="alert(1)">')).not.toContain("<img src=x");
  });
});
