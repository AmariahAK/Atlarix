/**
 * Keep active-mode prompts and tools_registry aligned with mode-tool-registry.
 */
import { describe, expect, it } from "vitest";
import {
  MODE_SYSTEM_TOOL_LISTS,
  constructSystemPromptParts,
} from "../prompts/system_prompt";
import {
  getModeToolAllowlist,
  getModeRegistryDisplayLabel,
  isToolAllowedInMode,
  EVERY_MODE_TOOLS,
} from "../lib/tools/mode-tool-registry";
import { ToolRegistry } from "../lib/tools/registry";
import "../lib/tools";

const ALL_MODE_LABELS = ["Explore", "Plan", "Build", "Debug", "Review"] as const;

function sortNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

function otherModeHeaders(activeLabel: string): string[] {
  return ALL_MODE_LABELS.filter((l) => l !== activeLabel).map(
    (l) => `## Current mode: ${l}`,
  );
}

describe("mode system consistency", () => {
  for (const mode of ["ask", "plan", "review"] as const) {
    it(`MODE_SYSTEM_TOOL_LISTS.${mode} matches registry allowlist`, () => {
      expect(sortNames(MODE_SYSTEM_TOOL_LISTS[mode])).toEqual(
        sortNames(getModeToolAllowlist(mode)),
      );
    });

    it(`MODE_SYSTEM_TOOL_LISTS.${mode} is alphabetically sorted`, () => {
      const tools = [...MODE_SYSTEM_TOOL_LISTS[mode]];
      expect(tools).toEqual(sortNames(tools));
    });
  }

  for (const mode of ["ask", "plan", "build", "debug", "review"] as const) {
    it(`each mode gets its own tools_registry (${mode})`, () => {
      const label = getModeRegistryDisplayLabel(mode);
      const { stableHeader } = constructSystemPromptParts({
        chatMode: mode === "build" ? "build" : "ask",
        effectiveWorkMode: mode,
        hasWorkspace: true,
      });
      expect(stableHeader).toContain(`<tools_registry mode="${mode}" label="${label}">`);
      expect(stableHeader).toContain("Workspace chat:");
      expect(stableHeader).not.toContain("Explore, Plan, Build");
    });
  }

  it("ask header shows Explore only, not other mode headers", () => {
    const { stableHeader } = constructSystemPromptParts({
      chatMode: "ask",
      effectiveWorkMode: "ask",
      hasWorkspace: true,
    });
    expect(stableHeader).toContain("## Current mode: Explore");
    for (const h of otherModeHeaders("Explore")) {
      expect(stableHeader).not.toContain(h);
    }
    expect(stableHeader).toContain("<work_mode>");
    expect(stableHeader).not.toMatch(/switch to \*\*Plan\*\*/i);
    expect(stableHeader).not.toMatch(/switch to \*\*Build\*\*/i);
  });

  it("registeredToolNames appear in tools_registry when provided", () => {
    const { stableHeader } = constructSystemPromptParts({
      chatMode: "ask",
      effectiveWorkMode: "ask",
      hasWorkspace: true,
      registeredToolNames: ["read_file", "search"],
    });
    expect(stableHeader).toContain("Native schemas bound now: read_file, search");
  });

  it("run_command is offered in Ask-mode tool discovery (allowInAskMode)", () => {
    const askNames = ToolRegistry.getToolsForAskMode().map((t) => t.name);
    expect(askNames).toContain("run_command");
  });

  it("debug mode allows all tools (full-surface marker)", () => {
    expect(MODE_SYSTEM_TOOL_LISTS.debug).toEqual(["*"]);
    expect(isToolAllowedInMode("write_file", "debug")).toBe(true);
  });

  it("ask allowlist does not include get_mode_tool_registry", () => {
    expect(MODE_SYSTEM_TOOL_LISTS.ask).not.toContain("get_mode_tool_registry");
  });

  // ── v10: mode isolation + every-mode tool guarantees ─────────────────────

  for (const mode of ["ask", "plan", "build", "debug", "review"] as const) {
    it(`${mode} prompt shows ONLY its own mode header (no leakage)`, () => {
      const label = getModeRegistryDisplayLabel(mode);
      const headerLabel =
        mode === "ask" ? "Explore" : mode === "debug" ? "Debug" : label;
      const { stableHeader } = constructSystemPromptParts({
        chatMode: mode === "build" ? "build" : "ask",
        effectiveWorkMode: mode,
        hasWorkspace: true,
      });
      for (const other of ALL_MODE_LABELS) {
        if (other === headerLabel) continue;
        expect(stableHeader).not.toContain(`## Current mode: ${other}`);
      }
      // The legacy all-modes block must never reach a mode-scoped prompt.
      expect(stableHeader).not.toContain("Tools registered in EVERY mode:");
    });
  }

  for (const mode of ["ask", "plan", "review"] as const) {
    it(`${mode} allowlist includes every-mode tools (tool_contract parity)`, () => {
      for (const tool of EVERY_MODE_TOOLS) {
        expect(getModeToolAllowlist(mode)).toContain(tool);
        expect(isToolAllowedInMode(tool, mode)).toBe(true);
      }
    });
  }
  it("every-mode tools are allowed in debug (full surface)", () => {
    for (const tool of EVERY_MODE_TOOLS) {
      expect(isToolAllowedInMode(tool, "debug")).toBe(true);
    }
  });

  it("read-only modes do not allow mutating tools", () => {
    for (const tool of ["write_file", "edit_file", "delete_file", "rename_file", "write_multiple_files"]) {
      expect(isToolAllowedInMode(tool, "ask")).toBe(false);
      expect(isToolAllowedInMode(tool, "review")).toBe(false);
    }
    // Plan is filesystem-read-only — it authors plans via the `plan` tool, NOT write_file/run_command.
    expect(isToolAllowedInMode("write_file", "plan")).toBe(false);
    expect(isToolAllowedInMode("run_command", "plan")).toBe(false);
    // Build allows all.
    expect(isToolAllowedInMode("write_file", "build")).toBe(true);
  });

  for (const mode of ["ask", "plan", "review"] as const) {
    it(`${mode} rendered tools_registry lists exactly its allowlist`, () => {
      const { stableHeader } = constructSystemPromptParts({
        chatMode: "ask",
        effectiveWorkMode: mode,
        hasWorkspace: true,
      });
      const registryMatch = stableHeader.match(
        new RegExp(`<tools_registry mode="${mode}"[\\s\\S]*?</tools_registry>`),
      );
      expect(registryMatch).not.toBeNull();
      const registry = registryMatch![0];
      for (const tool of getModeToolAllowlist(mode)) {
        expect(registry).toContain(tool);
      }
    });
  }
});
