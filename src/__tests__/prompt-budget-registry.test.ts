import { describe, expect, it } from "vitest";

/**
 * The prompt-budget measurement must work WITHOUT anything else having imported
 * the tool index first.
 *
 * WHY THIS FILE IMPORTS SO LITTLE
 * -------------------------------
 * That is the whole test. Tools register themselves as a side effect of
 * importing `lib/tools/index`; nothing calls an `initializeTools()` at startup.
 * `resolve-toolset` imports `ToolRegistry` from `./registry` directly, so it
 * does not pull the index in — which means the meter can run against an EMPTY
 * registry, resolve zero tools, and report a prefix of zero tool tokens without
 * throwing anything.
 *
 * That was briefly real. The side-effect import in `prompt-budget.ts` was
 * removed alongside an unused helper a dead-code report had flagged, and the
 * measurement silently returned `{toolCount: 0, total: 0}` — under-reporting by
 * ~10,000 tokens and looking exactly like a saving. Caught by running the
 * packaged app and asking where the registry gets populated.
 *
 * So: DO NOT add `import "@/lib/tools"` to this file. Its absence is the
 * assertion.
 */

import { measureToolSurface } from "@/lib/context/prompt-budget";

describe("prompt budget — registry population", () => {
  it("resolves a real tool surface with no prior index import", () => {
    const m = measureToolSurface({
      workMode: "build",
      hasWorkspace: true,
      workspaceIntegrationEligible: true,
      model: { name: "glm-5.3", provider: "compass" },
    });
    expect(
      m.toolCount,
      "zero tools means the ToolRegistry was empty — the side-effect import " +
        "in prompt-budget.ts is missing",
    ).toBeGreaterThan(20);
    // Real numbers, not a shape that happens to be non-zero.
    expect(m.descriptionTokens).toBeGreaterThan(1_000);
    expect(m.schemaTokens).toBeGreaterThan(1_000);
    expect(m.total).toBe(m.descriptionTokens + m.schemaTokens);
  });

  it("measures every mode, and read-only modes bind fewer tools than Build", () => {
    const surface = (workMode: "ask" | "plan" | "build" | "debug" | "review") =>
      measureToolSurface({
        workMode,
        hasWorkspace: true,
        workspaceIntegrationEligible: true,
        model: { name: "glm-5.3", provider: "compass" },
      });

    const build = surface("build");
    for (const mode of ["ask", "plan", "review"] as const) {
      const m = surface(mode);
      expect(m.toolCount, `${mode} bound no tools`).toBeGreaterThan(0);
      expect(
        m.toolCount,
        `${mode} should bind fewer tools than Build`,
      ).toBeLessThan(build.toolCount);
    }
    // Debug shares Build's surface by design (mode-tool-registry: they differ
    // by prompt discipline only), so it must NOT be smaller.
    expect(surface("debug").toolCount).toBe(build.toolCount);
  });
});
