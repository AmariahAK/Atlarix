/**
 * What the bridge is allowed to reach, enforced on the import GRAPH.
 *
 * ══ THE DEFECT THIS PREVENTS ══
 *
 * `tools/dispatch.ts` already knows how to click a ref, read a page and open a
 * tab. Reusing it from `serve.ts` is the obvious move and it is wrong: it pulls
 * in `core/client.ts` (the model), the approval plumbing and the panel's
 * `needsApproval` round trip, all of which would then run INSIDE a bridged
 * request. The user would be asked twice for one action — once by the desktop,
 * which already asked, and once by a panel that may not even be open — and the
 * second prompt would be unanswerable if it were not.
 *
 * ══ WHY TRANSITIVELY, AND NOT JUST THE FIRST LINE ══
 *
 * The import that breaks this will not be `dispatch`. It will be a helper that
 * looks harmless and imports it two levels down. A check on `serve.ts`'s own
 * import list would pass while the model client was being dragged into the
 * service worker, so the whole reachable set is walked.
 *
 * Read with `import.meta.glob` rather than `node:fs` for the reason
 * `no-node-globals.test.ts` gives: a guard that breaks the package's own rule
 * is not one.
 */

import { describe, expect, it } from "vitest";

const RAW = import.meta.glob("../**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Everything keyed by its path under `src/`.
 *
 * Vite normalises glob keys against the IMPORTING file, so a sibling arrives as
 * "./serve.ts" and a cousin as "../page/inject.ts". Two spellings for one
 * location is how the first version of this guard walked an empty graph and
 * reported success — it resolved every import to a key that did not exist. One
 * canonical space, computed once.
 */
function canonical(relative: string, fromDir: string): string {
  const parts = fromDir === "" ? [] : fromDir.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "." || segment === "") continue;
    else if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** This test lives in src/bridge, which is what every glob key is relative to. */
const HERE = "bridge";

const SOURCES: Record<string, string> = {};
for (const [key, source] of Object.entries(RAW)) {
  SOURCES[canonical(key, HERE)] = source;
}

/** Modules the bridge must never reach, however many hops away. */
const FORBIDDEN = [
  { pattern: /^agent\/loop$/, why: "the agent loop would run inside a bridged request" },
  { pattern: /^tools\/dispatch$/, why: "it drags in the model client and the approval plumbing" },
  { pattern: /^core\/client$/, why: "a bridged request must never reach the model" },
  { pattern: /^panel\//, why: "the bridge answers whether or not a panel is open" },
];

function importsOf(source: string): string[] {
  const out: string[] = [];
  // Both `import … from "x"` and `export … from "x"`, value and type.
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/g)) {
    out.push(m[1]!);
  }
  return out;
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const fromDir = fromFile.split("/").slice(0, -1).join("/");
  const base = canonical(spec, fromDir);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (candidate in SOURCES) return candidate;
  }
  return null;
}

/** Everything reachable from an entry module, with the path that got there. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; path: string[] }> = [{ file: entry, path: [entry] }];

  while (queue.length > 0) {
    const { file, path } = queue.shift()!;
    const source = SOURCES[file];
    if (source === undefined) continue;

    for (const spec of importsOf(source)) {
      const resolved = resolveImport(file, spec);
      const key = resolved ?? spec;
      if (seen.has(key)) continue;
      seen.set(key, [...path, key]);
      if (resolved) queue.push({ file: resolved, path: [...path, resolved] });
    }
  }
  return seen;
}

describe("the bridge's import graph", () => {
  it("finds the modules it is supposed to be walking", () => {
    // Guards the guard: a glob that matched nothing, or a resolver that
    // resolved nothing, would make every assertion below vacuously true.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
    const graph = reachable("bridge/serve.ts");
    expect(graph.size).toBeGreaterThan(3);
    expect([...graph.keys()]).toContain("page/inject.ts");
  });

  for (const entry of ["bridge/serve.ts", "bridge/native-port.ts"]) {
    it(`${entry} reaches nothing from the panel, the loop or the model`, () => {
      const graph = reachable(entry);
      const broken: string[] = [];
      for (const [module, how] of graph) {
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(module.replace(/\.ts$/, ""))) {
            broken.push(`${module} — ${why}\n      via ${how.join(" -> ")}`);
          }
        }
      }
      expect(broken).toEqual([]);
    });
  }

  it("catches a forbidden import several hops down, not just a direct one", () => {
    // The break this guard is actually for. Proven against a synthetic graph
    // so the real files stay untouched: `serve -> helper -> dispatch` must be
    // reported, because the import that breaks the rule will never be the
    // obvious one.
    const chain = reachable("tools/dispatch.ts");
    expect(chain.size).toBeGreaterThan(3);
    const reachesModel = [...chain.keys()].some((m) => /^core\/client$/.test(m.replace(/\.ts$/, "")));
    // dispatch legitimately reaches the model client; that is precisely why the
    // bridge must not reach dispatch.
    expect(reachesModel).toBe(true);
  });
});
