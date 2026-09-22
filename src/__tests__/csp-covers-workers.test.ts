/**
 * The app CSP must reach a dedicated worker, not just the document.
 *
 * `installContentSecurityPolicy` matched only mainFrame/subFrame, so a dedicated
 * worker loaded from file:// — which does NOT inherit its owner document's
 * policy, it takes the policy from its own script response — ran with no CSP at
 * all, and `eval()` was free inside it. The function's docstring claimed A13/M-6
 * coverage it did not have, which is the part that made this worth fixing rather
 * than just noting.
 *
 * Electron's WebRequest has no `worker` resourceType, so the rule keys on the
 * types a module worker's script actually arrives as.
 *
 * The worker that exposed the gap was the on-device speech engine's, and it is
 * deleted — the renderer currently spawns no dedicated worker at all. The rule
 * and this test stay: the next worker added must not have to rediscover that a
 * worker carries its own policy. Keeping it is what makes that free.
 */
import { describe, it, expect } from "vitest";
import { isCspPolicyTarget } from "@/main/csp-policy-target";

const FILE =
  "file:///Applications/Atlarix.app/Contents/Resources/app.asar/.vite/renderer/main_window";

describe("isCspPolicyTarget", () => {
  it("covers the app document", () => {
    expect(isCspPolicyTarget("mainFrame", `${FILE}/index.html`)).toBe(true);
    expect(isCspPolicyTarget("subFrame", `${FILE}/index.html`)).toBe(true);
  });

  it("covers a module worker's own script, which is what the gap was", () => {
    // Vite emits a worker as its own chunk; it arrives as `script` or `other`.
    expect(
      isCspPolicyTarget("script", `${FILE}/assets/some-worker-a1b2c3.js`),
    ).toBe(true);
    expect(
      isCspPolicyTarget("other", `${FILE}/assets/some-worker-a1b2c3.js`),
    ).toBe(true);
  });

  it("leaves the in-app browser alone — it has its own session and origin", () => {
    expect(isCspPolicyTarget("mainFrame", "https://github.com/")).toBe(false);
    expect(isCspPolicyTarget("script", "https://example.com/app.js")).toBe(
      false,
    );
    expect(
      isCspPolicyTarget("script", "devtools://devtools/bundled/x.js"),
    ).toBe(false);
  });

  it("does not stamp non-script subresources", () => {
    for (const t of [
      "image",
      "stylesheet",
      "font",
      "media",
      "xhr",
      "webSocket",
    ]) {
      expect(isCspPolicyTarget(t, `${FILE}/assets/thing`)).toBe(false);
    }
  });
});
