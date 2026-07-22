import { describe, expect, it } from "vitest";
import {
  delegateScopeFromArgs,
  isDelegateToolName,
  filterDelegateToolParts,
} from "@/lib/chat/delegate-handoff";
import {
  initialSubagentProgressPreview,
  scopeFromDelegateArgs,
} from "@/lib/chat/subagent-activity";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";

describe("isDelegateToolName", () => {
  // `task` (spawn-task.ts) is the ONLY delegate tool registered today, but the
  // predicate knew just the two legacy names — so it returned false for every
  // real delegation. That single omission disabled delegate-part filtering,
  // the round panel's split position, and round synthesis all at once, which
  // is how delegate tool cards ended up duplicated at the message tail.
  it("recognises the currently registered delegate tool", () => {
    expect(isDelegateToolName("task")).toBe(true);
  });

  it("still recognises the legacy names (persisted sessions)", () => {
    expect(isDelegateToolName("delegate_to_agent")).toBe(true);
    expect(isDelegateToolName("spawn_sub_agent")).toBe(true);
  });

  it("does not match ordinary tools", () => {
    for (const name of ["read_file", "run_command", "grep", "plan"]) {
      expect(isDelegateToolName(name), name).toBe(false);
    }
  });

  it("filters `task` parts once a round panel represents them", () => {
    const parts = [
      { type: "tool", id: "t1", toolName: "task", status: "success" },
      { type: "tool", id: "t2", toolName: "read_file", status: "success" },
    ] as unknown as AssistantMessagePart[];
    expect(filterDelegateToolParts(parts, true)).toHaveLength(1);
    // No panel → nothing is hidden; the delegate row is the only record.
    expect(filterDelegateToolParts(parts, false)).toHaveLength(2);
  });
});

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
