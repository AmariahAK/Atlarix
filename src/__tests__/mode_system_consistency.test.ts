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
  MODE_EXCLUDED_TOOLS,
} from "../lib/tools/mode-tool-registry";
import { ToolRegistry } from "../lib/tools/registry";
import "../lib/tools";

const ALL_MODES = ["ask", "plan", "build", "debug", "review"] as const;

// Derived, never hardcoded. A literal list here diverged from MODE_LABELS: this
// file said "Debug" while the registry (and the UI) said "Fix", which is how the
// same rendered prompt ended up carrying both.
const ALL_MODE_LABELS = ALL_MODES.map(getModeRegistryDisplayLabel);

function sortNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

function otherModeHeaders(activeLabel: string): string[] {
  return ALL_MODE_LABELS.filter((l) => l !== activeLabel).map(
    (l) => `## Current mode: ${l}`,
  );
}

/**
 * THE standing guard: a mode's prompt must never name a tool that mode cannot call.
 *
 * Three real contradictions shipped before this existed — Plan mode's prompt
 * advertised `run_command` and `edit_file`, neither of which is in PLAN_ALLOWLIST,
 * so any turn that believed the prompt burned a step. The allowlist is ground
 * truth; the prompt describes it and never contradicts it.
 */
describe("no mode's prompt names a tool it cannot call", () => {
  // Tools whose names appear in prose for reasons other than "you may call this":
  // pointing the user at another mode, or naming a tool to forbid it.
  const MENTION_IS_NOT_A_CLAIM =
    /you have no |you CANNOT|switch to|not available in this mode|are BLOCKED|\bno `?\w+`? here/i;

  for (const mode of ALL_MODES) {
    it(`${mode} prompt only names callable tools`, () => {
      const { stableHeader } = constructSystemPromptParts({
        chatMode: mode === "build" || mode === "debug" ? "build" : "ask",
        effectiveWorkMode: mode,
        hasWorkspace: true,
      });
      // Strip the <tools_registry> block: it lists the allowlist verbatim by design.
      const prose = stableHeader.replace(
        /<tools_registry[\s\S]*?<\/tools_registry>/g,
        "",
      );

      const offenders: string[] = [];
      for (const tool of ToolRegistry.getAll().map((t) => t.name)) {
        if (isToolAllowedInMode(tool, mode)) continue;
        // Word-boundary match so `plan` doesn't match "planning".
        const re = new RegExp(`\\b${tool.replace(/_/g, "_")}\\b`);
        for (const line of prose.split("\n")) {
          if (!re.test(line)) continue;
          if (MENTION_IS_NOT_A_CLAIM.test(line)) continue;
          offenders.push(`${tool} in: ${line.trim().slice(0, 120)}`);
          break;
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});

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
      expect(stableHeader).toContain(
        `<tools_registry mode="${mode}" label="${label}">`,
      );
      expect(stableHeader).toContain("Enabled MCP servers:");
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
    expect(stableHeader).not.toMatch(/switch to \*\*Plan\*\*/i);
    expect(stableHeader).not.toMatch(/switch to \*\*Build\*\*/i);
  });

  it("only Plan renders a <work_mode> block", () => {
    // The mode rules were stated THREE times in the same prompt — header,
    // <work_mode>, reanchor. This layer is gone for the four modes whose CAN/CANNOT
    // the toolset and sandbox already enforce. Plan keeps it because Plan is a
    // workflow, not a permission set: nothing enforces "reconcile the sub-agent's
    // draft into a plan the user reviews".
    for (const mode of ALL_MODES) {
      const { stableHeader } = constructSystemPromptParts({
        chatMode: mode === "build" || mode === "debug" ? "build" : "ask",
        effectiveWorkMode: mode,
        hasWorkspace: true,
      });
      if (mode === "plan") expect(stableHeader).toContain("<work_mode>");
      else expect(stableHeader).not.toContain("<work_mode>");
    }
  });

  it("registeredToolNames appear in tools_registry when provided", () => {
    const { stableHeader } = constructSystemPromptParts({
      chatMode: "ask",
      effectiveWorkMode: "ask",
      hasWorkspace: true,
      registeredToolNames: ["read_file", "search"],
    });
    expect(stableHeader).toContain(
      "Native schemas bound now: read_file, search",
    );
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
      // The header now derives its label from the registry, so no per-mode
      // special-casing. This used to read `mode === "debug" ? "Debug" : label`
      // — encoding the very drift it should have caught.
      const headerLabel = getModeRegistryDisplayLabel(mode);
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

  /**
   * An every-mode tool reaches every mode, EXCEPT where a mode subtracts it.
   *
   * `MODE_EXCLUDED_TOOLS` has exactly one entry — the mobile pair, out of Plan.
   * The pair was made every-mode on the argument that "what does the app look
   * like on a phone" is a QUESTION, which is Explore's job; Plan writes down
   * what should be done, and it is the mode with no budget headroom left once it
   * gained run_command. The exclusion is REAL, not cosmetic: the tool is
   * unreachable in that mode at the execute-time gate too, which is why this
   * asserts both halves rather than only the advertised list.
   *
   * Keep this list tiny. Every entry is a place where "every mode" stops being
   * literally true, and a reader has to come here to find out why.
   */
  for (const mode of ["ask", "plan", "review"] as const) {
    it(`${mode} allowlist includes every-mode tools (tool_contract parity)`, () => {
      const excluded = new Set(MODE_EXCLUDED_TOOLS[mode] ?? []);
      for (const tool of EVERY_MODE_TOOLS) {
        if (excluded.has(tool)) {
          expect(getModeToolAllowlist(mode)).not.toContain(tool);
          expect(isToolAllowedInMode(tool, mode)).toBe(false);
          continue;
        }
        expect(getModeToolAllowlist(mode)).toContain(tool);
        expect(isToolAllowedInMode(tool, mode)).toBe(true);
      }
    });
  }

  it("every-mode subtractions: the mobile pair out of Plan, transcribe_audio out of Review", () => {
    // Pinned so a future exclusion is a deliberate edit here rather than a
    // quiet erosion of what "every mode" means. Review's (2026-10-07): audio is
    // not part of reviewing code, and its schema pushed Review over budget.
    expect(Object.keys(MODE_EXCLUDED_TOOLS).sort()).toEqual(["plan", "review"]);
    expect([...(MODE_EXCLUDED_TOOLS.plan ?? [])].sort()).toEqual([
      "mobile",
      "mobile_inspect",
    ]);
    expect([...(MODE_EXCLUDED_TOOLS.review ?? [])]).toEqual([
      "transcribe_audio",
    ]);
  });
  it("every-mode tools are allowed in debug (full surface)", () => {
    for (const tool of EVERY_MODE_TOOLS) {
      expect(isToolAllowedInMode(tool, "debug")).toBe(true);
    }
  });

  it("read-only modes do not allow mutating tools", () => {
    for (const tool of [
      "write_file",
      "edit_file",
      "delete_file",
      "rename_file",
      "write_multiple_files",
    ]) {
      expect(isToolAllowedInMode(tool, "ask")).toBe(false);
      expect(isToolAllowedInMode(tool, "review")).toBe(false);
    }
    // Plan authors plans via the `plan` tool and has no file-writing tool. It
    // DOES have run_command: "does not implement" is enforced by having no
    // edit_file plus the gate's mutation verdict, not by refusing `git log`.
    expect(isToolAllowedInMode("write_file", "plan")).toBe(false);
    expect(isToolAllowedInMode("edit_file", "plan")).toBe(false);
    expect(isToolAllowedInMode("run_command", "plan")).toBe(true);
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
