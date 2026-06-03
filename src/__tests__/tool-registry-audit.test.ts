import { describe, expect, it } from "vitest";
import "../lib/tools";
import {
  auditToolRegistry,
  BUILD_ONLY_TOOLS,
  getComputedBuildOnlyTools,
} from "../lib/tools/tool-registry-audit";

describe("tool registry audit", () => {
  it("every non-build allowlist name is registered", () => {
    const { allowlistNotRegistered } = auditToolRegistry();
    expect(allowlistNotRegistered).toEqual([]);
  });

  it("every registered tool is on an allowlist, global set, or BUILD_ONLY_TOOLS", () => {
    const { registeredNotAccounted, buildOnlyDrift } = auditToolRegistry();
    expect(registeredNotAccounted).toEqual([]);
    expect(buildOnlyDrift.missing).toEqual([]);
    expect(buildOnlyDrift.extra).toEqual([]);
  });

  it("BUILD_ONLY_TOOLS matches tools outside mode unions and global set", () => {
    expect([...BUILD_ONLY_TOOLS].sort()).toEqual(getComputedBuildOnlyTools());
  });
});
