import { describe, it, expect } from "vitest";
import {
  resolveWorkspaceAppId,
  showWorkspaceModeControls,
} from "./show-workspace-mode-controls";

describe("resolveWorkspaceAppId", () => {
  it("returns first non-null source in priority order", () => {
    expect(
      resolveWorkspaceAppId({
        workspaceAppId: 1,
        selectedAppId: 2,
        currentAppId: 3,
        workspaceInfoId: 4,
      }),
    ).toBe(1);
  });

  it("falls through to selectedAppId when workspaceAppId is null", () => {
    expect(
      resolveWorkspaceAppId({
        workspaceAppId: null,
        selectedAppId: 2,
        currentAppId: 3,
      }),
    ).toBe(2);
  });

  it("returns null when all sources are null", () => {
    expect(
      resolveWorkspaceAppId({
        workspaceAppId: null,
        selectedAppId: null,
        currentAppId: null,
        workspaceInfoId: null,
      }),
    ).toBeNull();
  });
});

describe("showWorkspaceModeControls", () => {
  it("is true when workspace is bound and message is not synthetic", () => {
    expect(showWorkspaceModeControls({ isSynthetic: false }, 1)).toBe(true);
  });

  it("is false when workspace is null", () => {
    expect(showWorkspaceModeControls({ isSynthetic: false }, null)).toBe(false);
  });

  it("is false for synthetic messages even with workspace", () => {
    expect(showWorkspaceModeControls({ isSynthetic: true }, 1)).toBe(false);
  });
});
