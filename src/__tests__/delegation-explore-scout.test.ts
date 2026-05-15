import { describe, expect, it } from "vitest";
import { expandDelegationPreset } from "../lib/tools/delegation-presets";
import { getAgentMetadata } from "../lib/skills/skill-registry";
import { getToolManifest } from "../lib/skills/tool-manifest";

describe("delegate_to_agent explore/scout + presets", () => {
  it("registers explore and scout with expected skills", () => {
    expect(getAgentMetadata("explore")?.skillName).toBe("agents/explorer");
    expect(getAgentMetadata("scout")?.skillName).toBe("agents/scout");
  });

  it("expandDelegationPreset map_repo prefixes a read-only mapping brief", () => {
    const t = expandDelegationPreset("map_repo", "Map auth flow", undefined);
    expect(t).toContain("Read-only repository map");
    expect(t).toContain("Map auth flow");
  });

  it("expandDelegationPreset dependency_web_scout mentions dependencies", () => {
    const t = expandDelegationPreset("dependency_web_scout", "Trace imports of X", "src/a.ts");
    expect(t).toContain("Scout dependencies");
    expect(t).toContain("src/a.ts");
  });

  it("explorer and scout manifests are read-only", () => {
    expect(getToolManifest("agents/explorer").readOnly).toBe(true);
    expect(getToolManifest("agents/scout").allowed).toContain("web_search");
  });
});
