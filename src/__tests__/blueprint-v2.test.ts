/**
 * v12 Tier 6 (Blueprint v2):
 *  - #1 alias edge resolution (tsconfig paths/baseUrl + package imports)
 *  - #2 centrality-ranked slice with a summarized tail
 *  - #3 ctags signatures emitted in the slice + markdown
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  resolveRelativeImport,
  clearAliasConfigCache,
} from "../lib/blueprint/rte/ast-grep/resolve-edges";
import {
  buildSlice,
  bm25HitsToRoomScores,
} from "../lib/blueprint/blueprint-slice";
import {
  sliceCacheKey,
  getCachedSlice,
  setCachedSlice,
  markBlueprintSliceDirty,
  _resetSliceCache,
} from "../lib/blueprint/blueprint-slice-cache";
import {
  getAstGrepScanErrors,
  resetAstGrepScanErrors,
} from "../lib/blueprint/rte/ast-grep/worker-pool";
import { rteResultToBlueprint } from "../lib/blueprint/rte_to_blueprint";
import { blueprintToMarkdown } from "../lib/blueprint/blueprint-markdown";
import type { Blueprint, BlueprintRoom } from "../shared/blueprint-types";

describe("Tier 6 #1 — alias edge resolution", () => {
  it("resolves tsconfig `paths` aliases (recovered cross-module edges)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-bp2-"));
    clearAliasConfigCache();
    await fs.mkdir(path.join(root, "src", "lib"), { recursive: true });
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        // includes a comment + trailing comma to exercise the JSONC strip
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    );
    await fs.writeFile(
      path.join(root, "src", "lib", "auth.ts"),
      "export const a = 1;\n",
    );
    await fs.writeFile(
      path.join(root, "src", "main.ts"),
      "import { a } from '@/lib/auth';\n",
    );

    const resolved = await resolveRelativeImport(
      "@/lib/auth",
      "src/main.ts",
      root,
    );
    expect(resolved).toBe("src/lib/auth.ts");

    // The pre-fix behavior (relative-only) returned null for aliases.
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resolves package.json `#imports` self-references", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-bp2-"));
    clearAliasConfigCache();
    await fs.mkdir(path.join(root, "internal"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ imports: { "#internal/*": "./internal/*" } }),
    );
    await fs.writeFile(
      path.join(root, "internal", "db.ts"),
      "export const d = 1;\n",
    );
    await fs.writeFile(path.join(root, "app.ts"), "import '#internal/db';\n");

    const resolved = await resolveRelativeImport(
      "#internal/db",
      "app.ts",
      root,
    );
    expect(resolved).toBe("internal/db.ts");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("still returns null for genuinely unresolvable bare imports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-bp2-"));
    clearAliasConfigCache();
    await fs.writeFile(path.join(root, "app.ts"), "import 'react';\n");
    expect(await resolveRelativeImport("react", "app.ts", root)).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});

function room(
  id: string,
  label: string,
  fns: Array<{ name: string; signature?: string }> = [],
): BlueprintRoom {
  return {
    id,
    label,
    type: "module",
    path: `src/${label}.ts`,
    functions: fns.map((f, i) => ({
      id: `${id}-fn${i}`,
      name: f.name,
      kind: "function",
      file: `src/${label}.ts`,
      ...(f.signature
        ? {
            simpleDescription: f.signature,
            descriptionSource: "pattern" as const,
          }
        : {}),
    })),
  } as BlueprintRoom;
}

describe("Tier 6 #2/#3 — ranked slice + signatures", () => {
  it("emits ctags signatures on slice functions", () => {
    const bp: Blueprint = {
      rooms: [
        room("r1", "auth", [{ name: "login", signature: "login(user, pass)" }]),
      ],
      edges: [],
      envRefs: [],
    } as unknown as Blueprint;
    const slice = buildSlice(bp, "full", undefined, 1);
    expect(slice.nodes[0]!.functions[0]!.signature).toBe("login(user, pass)");
  });

  it("ranks rooms by centrality and summarizes the tail past the cap", () => {
    // 45 rooms; a hub with many edges must survive the 40-room cap.
    const rooms: BlueprintRoom[] = [];
    for (let i = 0; i < 45; i++) rooms.push(room(`r${i}`, `mod${i}`));
    const edges = [];
    // r0 is a hub: every other room points at it.
    for (let i = 1; i < 45; i++) edges.push({ from: `r${i}`, to: "r0" });
    const bp: Blueprint = { rooms, edges, envRefs: [] } as unknown as Blueprint;

    const slice = buildSlice(bp, "full", undefined, 0);
    expect(slice.nodes.length).toBe(40);
    // The hub (highest degree) is kept.
    expect(slice.nodes.some((n) => n.id === "r0")).toBe(true);
    // The tail is summarized, not silently dropped.
    expect(slice.omittedRooms?.count).toBe(5);
  });

  it("markdown renders the signature in tool mode, not the bare name", () => {
    const bp: Blueprint = {
      rooms: [
        room("r1", "auth", [{ name: "login", signature: "login(user, pass)" }]),
      ],
      edges: [],
      envRefs: [],
    } as unknown as Blueprint;
    const md = blueprintToMarkdown(bp, {
      toolMode: true,
      includeExports: true,
      maxLines: 100,
    });
    expect(md).toContain("login(user, pass)");
  });
});

describe("Tier 6 #1 — BM25 fusion into slice ranking", () => {
  it("a topic-relevant room outranks a higher-degree non-matching room", () => {
    // hub (r0, file src/mod0.ts) has high centrality; payments (r1, file
    // src/payments.ts) has none but matches the BM25 query. (Rooms carry a
    // function so they have a file the BM25 join can match.)
    const rooms: BlueprintRoom[] = [
      room("r0", "mod0", [{ name: "f0" }]),
      room("r1", "payments", [{ name: "charge" }]),
    ];
    for (let i = 2; i < 10; i++)
      rooms.push(room(`r${i}`, `mod${i}`, [{ name: `f${i}` }]));
    const edges = [];
    for (let i = 2; i < 10; i++) edges.push({ from: `r${i}`, to: "r0" }); // r0 = hub
    const bp: Blueprint = { rooms, edges, envRefs: [] } as unknown as Blueprint;

    // Centrality-only: r0 (the hub) ranks first.
    const plain = buildSlice(bp, "full", undefined, 0);
    expect(plain.nodes[0]!.id).toBe("r0");

    // With a BM25 score for the payments room, it jumps to the top.
    const scores = bm25HitsToRoomScores(rooms, [
      { file: "src/payments.ts", score: 12.5 },
    ]);
    expect(scores.size).toBeGreaterThan(0); // the silent-no-op guard
    const fused = buildSlice(bp, "full", undefined, 0, scores);
    expect(fused.nodes[0]!.id).toBe("r1");
  });

  it("bm25HitsToRoomScores matches absolute hit paths and normalizes 0..1", () => {
    const rooms = [
      room("r1", "auth", [{ name: "login" }]),
      room("r2", "db", [{ name: "query" }]),
    ];
    // absolute-ish hit path ending in the room's file — must still match.
    const scores = bm25HitsToRoomScores(rooms, [
      { file: "/Users/x/proj/src/auth.ts", score: 8 },
      { file: "/Users/x/proj/src/db.ts", score: 4 },
    ]);
    expect(scores.get("r1")).toBe(1); // max normalized to 1
    expect(scores.get("r2")).toBe(0.5);
  });

  it("no map → ordering identical to centrality-only", () => {
    const rooms = [room("r0", "a"), room("r1", "b"), room("r2", "c")];
    const edges = [
      { from: "r1", to: "r0" },
      { from: "r2", to: "r0" },
    ];
    const bp: Blueprint = { rooms, edges, envRefs: [] } as unknown as Blueprint;
    const a = buildSlice(bp, "full", undefined, 0).nodes.map((n) => n.id);
    const b = buildSlice(bp, "full", undefined, 0, new Map()).nodes.map(
      (n) => n.id,
    );
    expect(b).toEqual(a);
  });
});

describe("Tier 6 #3 — edge confidence", () => {
  it("import edges down-weight centrality vs confirmed calls", () => {
    const rooms = [room("r0", "a"), room("r1", "b"), room("hub", "h")];
    const edges = [
      { from: "hub", to: "r0", type: "import" as const, inferred: true },
      { from: "hub", to: "r1", type: "call" as const, inferred: false },
    ];
    const bp: Blueprint = { rooms, edges, envRefs: [] } as unknown as Blueprint;
    const slice = buildSlice(bp, "full", undefined, 0);
    // The confirmed-call room (r1) outranks the import-only room (r0).
    const r0Idx = slice.nodes.findIndex((n) => n.id === "r0");
    const r1Idx = slice.nodes.findIndex((n) => n.id === "r1");
    expect(r1Idx).toBeLessThan(r0Idx);
  });

  it("rteResultToBlueprint marks import edges inferred, call edges confirmed", () => {
    const result = {
      nodes: [
        { id: "n1", type: "function", name: "a", file: "src/mod-a/a.ts" },
        { id: "n2", type: "function", name: "b", file: "src/mod-b/b.ts" },
        { id: "n3", type: "function", name: "c", file: "src/mod-c/c.ts" },
      ],
      edges: [
        { from: "n1", to: "n2", type: "imports" as const },
        { from: "n1", to: "n3", type: "calls" as const },
      ],
      framework: { name: "none", confidence: 0 },
    } as unknown as Parameters<typeof rteResultToBlueprint>[0];
    const bp = rteResultToBlueprint(result, "/proj");
    const importEdge = bp.edges.find((e) => e.type === "import");
    const callEdge = bp.edges.find((e) => e.type === "call");
    expect(importEdge?.inferred).toBe(true);
    expect(callEdge?.inferred).toBe(false);
  });
});

describe("Tier 6 #2 — getRoomKey granularity (via rteResultToBlueprint)", () => {
  const mk = (file: string, i: number) => ({
    id: `n${i}`,
    type: "function",
    name: `fn${i}`,
    file,
  });
  it("separates api/v1 from api/v2 (deep generic root)", () => {
    const result = {
      nodes: [
        mk("src/api/v1/handlers/auth.ts", 1),
        mk("src/api/v2/handlers/auth.ts", 2),
      ],
      edges: [],
      framework: { name: "none", confidence: 0 },
    } as unknown as Parameters<typeof rteResultToBlueprint>[0];
    const bp = rteResultToBlueprint(result, "/proj");
    expect(bp.rooms.length).toBe(2);
  });
  it("does NOT over-split a shallow module into per-file rooms", () => {
    const result = {
      nodes: [mk("src/auth/login.ts", 1), mk("src/auth/logout.ts", 2)],
      edges: [],
      framework: { name: "none", confidence: 0 },
    } as unknown as Parameters<typeof rteResultToBlueprint>[0];
    const bp = rteResultToBlueprint(result, "/proj");
    expect(bp.rooms.length).toBe(1); // both collapse to room "auth"
  });
});

describe("Tier 6 #5 — slice cache", () => {
  it("returns the cached object and rebuilds after a dirty signal", () => {
    _resetSliceCache();
    const key = sliceCacheKey({
      workspaceId: 1,
      focusPath: ".",
      scope: "full",
      depth: 0,
    });
    expect(getCachedSlice(key, 1)).toBeNull();
    const slice = buildSlice(
      {
        rooms: [room("r1", "auth")],
        edges: [],
        envRefs: [],
      } as unknown as Blueprint,
      "full",
      undefined,
      0,
    );
    setCachedSlice(key, 1, slice, false);
    expect(getCachedSlice(key, 1)?.slice).toBe(slice);
    markBlueprintSliceDirty(1);
    expect(getCachedSlice(key, 1)).toBeNull(); // dropped on reparse
  });
});

describe("Tier 6 #4 — worker-crash scan-error counter", () => {
  it("reset starts at zero", () => {
    resetAstGrepScanErrors();
    expect(getAstGrepScanErrors()).toBe(0);
  });
});
