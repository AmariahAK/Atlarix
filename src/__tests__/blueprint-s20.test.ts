/**
 * v12 S20 — Blueprint v2 tail: dynamic-call honesty, BM25 generic-identifier
 * downweight, thin-graph density override.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import createBm25Engine from "wink-bm25-text-search";
import { hasAstGrep } from "./helpers/native-tools";
import { scanCallsForFile } from "@/lib/blueprint/rte/ast-grep/scan-file-edges";
import type { SymbolRecord } from "@/lib/index/symbol-types";
import { assessBlueprintRichness } from "@/lib/blueprint/blueprint-quality";
import { isGenericIdentifierName } from "@/lib/search/bm25_semantic_index";
import type { Blueprint, BlueprintRoom } from "@/shared/blueprint-types";

// ── 1. dynamic-call counter ─────────────────────────────────────────────────

let ws: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-s20-"));
  fs.writeFileSync(
    path.join(ws, "caller.ts"),
    [
      'import { target } from "./target";',
      "declare const obj: any; declare const fn: string;",
      "declare const cond: boolean; declare const a: () => void; declare const b: () => void;",
      "export function caller() {",
      "  target();", // bare identifier → edge
      "  obj.method();", // member → dynamic (no edge)
      "  obj[fn]();", // computed → dynamic (no edge)
      "  (cond ? a : b)();", // expression → dynamic (no edge)
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(ws, "target.ts"),
    "export function target() {}\n",
  );
});

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

function sym(
  id: string,
  name: string,
  file: string,
  line: number,
  endLine: number,
): SymbolRecord {
  return {
    id,
    name,
    path: file,
    line,
    endLine,
    kind: "function",
  } as SymbolRecord;
}

describe.skipIf(!hasAstGrep())("dynamic-call counter (S20 #1)", () => {
  it("counts non-identifier callees instead of dropping them silently", async () => {
    const byFile = new Map<string, SymbolRecord[]>([
      ["caller.ts", [sym("c1", "caller", "caller.ts", 4, 9)]],
      ["target.ts", [sym("t1", "target", "target.ts", 1, 1)]],
    ]);
    const { edges, dynamicCalls } = await scanCallsForFile(ws, "caller.ts", byFile);
    // The bare call still resolves to an edge…
    expect(edges.some((e) => e.to === "t1" && e.type === "calls")).toBe(true);
    // …and the member/computed/expression callees are COUNTED, not silent.
    expect(dynamicCalls).toBeGreaterThanOrEqual(3);
  });

  it("a file with only bare calls counts zero", async () => {
    const byFile = new Map<string, SymbolRecord[]>([
      ["target.ts", [sym("t1", "target", "target.ts", 1, 1)]],
    ]);
    const { dynamicCalls } = await scanCallsForFile(ws, "target.ts", byFile);
    expect(dynamicCalls).toBe(0);
  });
});

// ── 2. BM25 generic-identifier downweight ───────────────────────────────────

function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}

describe("BM25 generic-identifier stoplist (S20 #2)", () => {
  it("classifies whole-name generics; specific names keep full weight", () => {
    expect(isGenericIdentifierName("process")).toBe(true);
    expect(isGenericIdentifierName("Handle")).toBe(true);
    expect(isGenericIdentifierName("get")).toBe(true);
    expect(isGenericIdentifierName("processPayment")).toBe(false);
    expect(isGenericIdentifierName("handleAuthCallback")).toBe(false);
    expect(isGenericIdentifierName("payment_processor")).toBe(false);
  });

  it("a symbol merely NAMED 'process' no longer outranks contextual matches", () => {
    // Replicates buildIndex's scheme: generic names move to nameGeneric:1.
    const engine = createBm25Engine();
    engine.defineConfig({
      fldWeights: { name: 4, nameGeneric: 1, signature: 2, snippet: 2 },
    });
    engine.definePrepTasks([tokenize]);

    const docs = [
      {
        // Generic-named symbol with zero contextual relevance.
        name: "",
        nameGeneric: "process",
        signature: "function process()",
        snippet: "function process() {",
      },
      {
        // Specific symbol whose CONTEXT is about processing.
        name: "runPaymentPipeline",
        nameGeneric: "",
        signature: "function runPaymentPipeline(queue: Queue)",
        snippet: "// process each payment in the queue, then process refunds",
      },
      {
        // Filler (wink-bm25 requires ≥3 docs to consolidate).
        name: "renderSidebar",
        nameGeneric: "",
        signature: "function renderSidebar(props: Props)",
        snippet: "return <aside>…</aside>",
      },
    ];
    docs.forEach((d, i) => engine.addDoc(d, i));
    engine.consolidate();

    const results = engine.search("process payment", 2) as Array<[number | string, number]>;
    expect(results.length).toBeGreaterThan(0);
    // The contextual doc wins the query — pre-stoplist, name:4 on a bare
    // "process" symbol dominated this ranking. (wink returns string ids.)
    expect(Number(results[0]![0])).toBe(1);
  });
});

// ── 3. thin-graph density override ──────────────────────────────────────────

function roomWithFiles(
  id: string,
  fnsPerFile: number,
  files: string[],
): BlueprintRoom {
  const functions = files.flatMap((f, fi) =>
    Array.from({ length: fnsPerFile }, (_, i) => ({
      id: `${id}-${fi}-${i}`,
      name: `fn_${fi}_${i}`,
      kind: "function" as const,
      file: f,
    })),
  );
  return { id, label: id, path: id, functions };
}

function bpWithEdge(rooms: BlueprintRoom[], edges: number): Blueprint {
  const edgeList =
    edges > 0 && rooms.length >= 2
      ? Array.from({ length: edges }, () => ({
          from: rooms[0]!.id,
          to: rooms[1]!.id,
          type: "import" as const,
        }))
      : [];
  return { rooms, edges: edgeList, envRefs: [] };
}

describe("thin-graph density override (S20 #3)", () => {
  it("a small-but-dense connected graph is NOT thin (Python small-module style)", () => {
    // 12 functions over 4 files (ratio 3 ≥ 2), 1 confirmed edge — under the
    // absolute THIN_FUNCTION_COUNT=15 but clearly a real, connected graph.
    const rooms = [
      roomWithFiles("api", 3, ["src/api/a.py", "src/api/b.py"]),
      roomWithFiles("lib", 3, ["src/lib/c.py", "src/lib/d.py"]),
    ];
    const r = assessBlueprintRichness(bpWithEdge(rooms, 1));
    expect(r.functionCount).toBe(12);
    expect(r.uniqueFiles).toBe(4);
    expect(r.quality).not.toBe("thin");
  });

  it("sparse one-function-per-file stays thin (ratio below threshold)", () => {
    const rooms = [
      roomWithFiles("a", 1, ["src/a/1.py", "src/a/2.py", "src/a/3.py"]),
      roomWithFiles("b", 1, ["src/b/4.py", "src/b/5.py", "src/b/6.py"]),
    ];
    const r = assessBlueprintRichness(bpWithEdge(rooms, 1));
    expect(r.quality).toBe("thin");
  });

  it("dense ratio on too few files stays thin (minimum-files guard)", () => {
    const rooms = [
      roomWithFiles("solo", 4, ["src/solo/one.py"]),
      roomWithFiles("duo", 4, ["src/duo/two.py"]),
    ];
    const r = assessBlueprintRichness(bpWithEdge(rooms, 1));
    expect(r.uniqueFiles).toBe(2);
    expect(r.quality).toBe("thin");
  });

  it("disconnected graphs never take the density escape hatch", () => {
    const rooms = [
      roomWithFiles("api", 3, ["src/api/a.py", "src/api/b.py"]),
      roomWithFiles("lib", 3, ["src/lib/c.py", "src/lib/d.py"]),
    ];
    const r = assessBlueprintRichness(bpWithEdge(rooms, 0));
    expect(r.quality).toBe("thin");
  });
});
