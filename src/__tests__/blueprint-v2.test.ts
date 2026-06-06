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
import { buildSlice } from "../lib/blueprint/blueprint-slice";
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
