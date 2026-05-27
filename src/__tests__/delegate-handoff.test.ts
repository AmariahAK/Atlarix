import { describe, expect, it } from "vitest";
import { delegateScopeFromArgs } from "@/lib/chat/delegate-handoff";
import {
  initialSubagentProgressPreview,
  scopeFromDelegateArgs,
} from "@/lib/chat/subagent-activity";

describe("delegateScopeFromArgs", () => {
  it("prefers default_focus_path over preset", () => {
    expect(
      delegateScopeFromArgs({
        default_focus_path: "spacinsider-api",
        preset: "map_repo",
      }),
    ).toBe("spacinsider-api");
  });

  it("does not use preset as display scope", () => {
    expect(
      delegateScopeFromArgs({
        preset: "map_repo",
        task: "Map the monorepo",
      }),
    ).toBe("Map the monorepo");
  });

  it("formats multiple scopes as N repos", () => {
    expect(
      delegateScopeFromArgs({
        scopes: ["repo-a", "repo-b", "repo-c"],
      }),
    ).toBe("3 repos");
  });

  it("scopeFromDelegateArgs passes scopes and task through", () => {
    expect(
      scopeFromDelegateArgs({
        scopes: ["frontend"],
        preset: "map_repo",
      }),
    ).toBe("frontend");
  });
});

describe("initialSubagentProgressPreview", () => {
  it("includes scope in mapping line", () => {
    expect(initialSubagentProgressPreview("api/", "ignored")).toBe("Mapping: api/");
  });
});
