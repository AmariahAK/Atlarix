import { describe, expect, it, vi, beforeEach } from "vitest";

const ensureBlueprintParsed = vi.fn();

vi.mock("@/lib/blueprint/lazy-parse", () => ({
  ensureBlueprintParsed: (...args: unknown[]) => ensureBlueprintParsed(...args),
}));

const ensureSymbolIndexForWorkspaceId = vi.fn(async () => ({
  symbols: [],
  manifest: {
    projectPath: "/",
    timestamp: 0,
    fileCount: 0,
    symbolCount: 0,
    engine: "ctags" as const,
  },
}));

vi.mock("@/lib/index/ctags-index", () => ({
  ensureSymbolIndexForWorkspaceId: (...args: unknown[]) =>
    (ensureSymbolIndexForWorkspaceId as (...a: unknown[]) => unknown)(...args),
  findSymbolsByName: vi.fn(() => []),
}));

vi.mock("electron-log", () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

describe("queryStructuralGraph", () => {
  beforeEach(() => {
    ensureBlueprintParsed.mockReset();
    ensureBlueprintParsed.mockResolvedValue({ rooms: [], edges: [], envRefs: [] });
  });

  it("does not call ensureBlueprintParsed when path is omitted", async () => {
    const { queryStructuralGraph } = await import("@/lib/search/structural-graph-query");
    await queryStructuralGraph({
      query: "handleLogin",
      workspaceId: 1,
      maxResults: 10,
    });
    expect(ensureBlueprintParsed).not.toHaveBeenCalled();
  });

  it("calls ensureBlueprintParsed with scoped focusPath when path is set", async () => {
    const { queryStructuralGraph } = await import("@/lib/search/structural-graph-query");
    await queryStructuralGraph({
      query: "handleLogin",
      workspaceId: 1,
      scopePath: "pkg-a",
      maxResults: 10,
    });
    expect(ensureBlueprintParsed).toHaveBeenCalledWith(1, {
      focusPath: "pkg-a",
      allowWorkspaceRoot: false,
    });
    expect(ensureSymbolIndexForWorkspaceId).toHaveBeenCalledWith(1, {
      scopePath: "pkg-a",
    });
  });
});
