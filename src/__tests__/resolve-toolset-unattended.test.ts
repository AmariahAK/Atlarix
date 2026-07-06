import { describe, expect, it } from "vitest";
import "@/lib/tools/index"; // side-effect: registers the full tool surface
import { resolveToolsetForSession } from "@/lib/tools/resolve-toolset";

/**
 * Unattended (automation) runs drop human-handoff + UI-view tools but keep the
 * app-infra tools that headless drops (MCP, web search, task) — automations
 * run inside the real app where that infra exists.
 */

function resolve(branch: "ask" | "build", unattended: boolean) {
  return resolveToolsetForSession({
    branch,
    effectiveWorkMode: branch,
    hasWorkspace: true,
    workspaceIntegrationEligible: true,
    model: { name: "gpt-test", provider: "openai" },
    unattended,
  }).tools.map((t) => t.name);
}

describe("resolveToolsetForSession unattended", () => {
  it("drops ask_user, preview_test, and browser_* in ask branch", () => {
    const names = resolve("ask", true);
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("preview_test");
    expect(names.some((n) => n.startsWith("browser_"))).toBe(false);
  });

  it("drops the same set in build branch", () => {
    const names = resolve("build", true);
    expect(names).not.toContain("ask_user");
    expect(names.some((n) => n.startsWith("browser_"))).toBe(false);
    expect(names).toContain("edit_file"); // writes still available (worktree runs)
  });

  it("keeps app-infra tools that headless drops", () => {
    const names = resolve("ask", true);
    expect(names).toContain("mcp_call");
    expect(names).toContain("web_search");
    expect(names).toContain("grep");
    expect(names).toContain("run_command");
  });

  it("attended runs are unchanged", () => {
    const attended = resolve("ask", false);
    expect(attended).toContain("ask_user");
    expect(attended.some((n) => n.startsWith("browser_"))).toBe(true);
  });
});
