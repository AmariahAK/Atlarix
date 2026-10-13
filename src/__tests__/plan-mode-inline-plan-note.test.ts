import { describe, expect, it } from "vitest";
import { renderModePromptBundle } from "@/lib/tools/mode-prompt-bundle";

const NOTE = "saved as the session's plan too";

describe("Plan mode's inline-plan note", () => {
  it("is there only where inline plans are saved (the CLI and the editor)", () => {
    expect(renderModePromptBundle("plan", { inlinePlans: true })).toContain(NOTE);
    // The desktop app does not save them: its prompt is unchanged.
    expect(renderModePromptBundle("plan")).not.toContain(NOTE);
  });

  it("is Plan mode's alone", () => {
    for (const mode of ["ask", "build", "debug", "review"] as const) {
      expect(renderModePromptBundle(mode, { inlinePlans: true })).not.toContain(NOTE);
    }
  });
});
