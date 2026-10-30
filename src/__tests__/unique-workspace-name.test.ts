/**
 * Two folders may share a basename; their workspaces must not share a name
 * (QA 2026-10-30: a second "ws" folder could not be opened at all).
 */
import { describe, expect, it } from "vitest";
import { uniqueWorkspaceName } from "../ipc/handlers/unique-workspace-name";

describe("uniqueWorkspaceName", () => {
  it("is the folder's name when free", () => {
    expect(uniqueWorkspaceName("/home/a/proj", new Set(["other"]))).toBe("proj");
  });
  it("adds the parent folder when the name is taken", () => {
    expect(uniqueWorkspaceName("/home/a/atlarix/ws", new Set(["ws"]))).toBe("ws (atlarix)");
  });
  it("counts up when the parent form is taken too, skipping taken numbers", () => {
    expect(uniqueWorkspaceName("/home/a/atlarix/ws", new Set(["ws", "ws (atlarix)", "ws (2)"]))).toBe("ws (3)");
  });
  it("never repeats the parent when it equals the name", () => {
    expect(uniqueWorkspaceName("/x/ws/ws", new Set(["ws"]))).toBe("ws (2)");
  });
});
