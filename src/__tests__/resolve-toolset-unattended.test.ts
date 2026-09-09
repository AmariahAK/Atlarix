import { describe, expect, it } from "vitest";
import "@/lib/tools/index"; // side-effect: registers the full tool surface
import { resolveToolsetForSession } from "@/lib/tools/resolve-toolset";

/**
 * Unattended (automation) runs drop human-handoff + UI-view tools but keep the
 * app-infra tools that headless drops (MCP, web search, task) — automations
 * run inside the real app where that infra exists.
 *
 * WHY THESE ASSERTIONS NAME TOOLS AND NO LONGER USE A PREFIX
 * ---------------------------------------------------------
 * Every UI-view assertion here used to read `n.startsWith("browser_")`, matching
 * the filter it was testing. When v14.41 consolidated six browser tools into
 * `browser_inspect` + **`browser`**, the filter silently stopped covering the act
 * tool — `"browser".startsWith("browser_")` is false — and these tests kept
 * passing, VACUOUSLY, because the assertion had the same blind spot as the code.
 *
 * A test that reuses the implementation's own predicate cannot catch the
 * predicate being wrong. So the tools are named.
 */

/** Every tool that drives a surface an unwatched/Electron-free run lacks. */
const DRIVES_A_VIEW = [
  "browser",
  "browser_inspect",
  "browser_test",
  "mobile",
  "mobile_inspect",
] as const;

function resolve(
  branch: "ask" | "build",
  unattended: boolean,
  opts?: { headless?: boolean },
) {
  const prev = process.env.ATLARIX_HEADLESS;
  if (opts?.headless) process.env.ATLARIX_HEADLESS = "1";
  try {
    return resolveToolsetForSession({
      branch,
      effectiveWorkMode: branch,
      hasWorkspace: true,
      workspaceIntegrationEligible: true,
      model: { name: "gpt-test", provider: "openai" },
      unattended,
    }).tools.map((t) => t.name);
  } finally {
    if (prev === undefined) delete process.env.ATLARIX_HEADLESS;
    else process.env.ATLARIX_HEADLESS = prev;
  }
}

describe("resolveToolsetForSession unattended", () => {
  it("drops ask_user and every view-driving tool in ask branch", () => {
    const names = resolve("ask", true);
    expect(names).not.toContain("ask_user");
    for (const tool of DRIVES_A_VIEW) {
      expect(names, `${tool} must not be offered unattended`).not.toContain(
        tool,
      );
    }
  });

  it("drops the same set in build branch", () => {
    const names = resolve("build", true);
    expect(names).not.toContain("ask_user");
    for (const tool of DRIVES_A_VIEW) {
      expect(names, `${tool} must not be offered unattended`).not.toContain(
        tool,
      );
    }
    expect(names).toContain("edit_file"); // writes still available (proposal runs)
  });

  it("keeps app-infra tools that headless drops, but drops read_url (exfil channel)", () => {
    const names = resolve("ask", true);
    expect(names).toContain("mcp_call");
    expect(names).toContain("web_search"); // routes through the configured aggregator
    expect(names).toContain("grep");
    expect(names).toContain("run_command");
    expect(names).not.toContain("read_url"); // arbitrary-host fetch dropped
  });

  it("attended runs are unchanged, and DO get the view tools", () => {
    const attended = resolve("ask", false);
    expect(attended).toContain("ask_user");
    expect(attended).toContain("read_url");
    // The positive control the prefix version could not express: the bare
    // `browser` act tool and the mobile pair are present when someone IS
    // watching. Without this, "dropped everywhere" would also pass.
    expect(attended).toContain("browser");
    expect(attended).toContain("browser_inspect");
    expect(attended).toContain("mobile");
    expect(attended).toContain("mobile_inspect");
  });

  it("HEADLESS drops the view tools too — the npm CLI has no window", () => {
    // The Electron-free CLI (`npm i -g atlarix`, and the Harbor agent that wraps
    // it) has no WebContentsView, so offering the browser there is prefix cost
    // for a tool that cannot run. The mobile pair goes with it: `adb` might well
    // exist on a benchmark machine, but an emulator does not, and a headless run
    // has nobody to look at one.
    const names = resolve("build", false, { headless: true });
    for (const tool of DRIVES_A_VIEW) {
      expect(names, `${tool} must not be offered headless`).not.toContain(tool);
    }
    // Headless keeps the tools a benchmark task actually needs.
    expect(names).toContain("run_command");
    expect(names).toContain("edit_file");
    expect(names).toContain("grep");
  });
});
