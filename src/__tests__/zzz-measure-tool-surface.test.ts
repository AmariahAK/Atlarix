import { it } from "vitest";
import { measureToolSurface } from "@/lib/context/prompt-budget";

it("print tool surface", () => {
  for (const mode of ["build", "ask", "plan", "review"] as const) {
    const m = measureToolSurface({
      workMode: mode,
      hasWorkspace: true,
      workspaceIntegrationEligible: true,
      model: { name: "glm-5.3", provider: "compass" },
    });
    console.log(
      `[4c-measure] ${mode}: tools=${m.toolCount} desc=${m.descriptionTokens} schema=${m.schemaTokens} total=${m.total}`,
    );
  }
});
