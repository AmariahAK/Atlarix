/**
 * Blueprint + ctags structural graph queries for search(structural).
 */

import type { Blueprint } from "@/shared/blueprint-types";
import {
  ensureSymbolIndexForWorkspaceId,
  findSymbolsByName,
  type SymbolIndexCache,
} from "@/lib/index/ctags-index";
import { ensureBlueprintParsed } from "@/lib/blueprint/lazy-parse";
import { bfsSymbolGraph, type SymbolEdge } from "@/lib/blueprint/rte/ast-grep/graph-bfs";

const CALLER_PHRASES = ["what calls", "who calls", "callers of"];
const IMPORT_PHRASES = ["what imports", "imports of", "who imports", "what depends on", "dependencies of"];

const DEFAULT_BFS_DEPTH = 2;
const MAX_BFS_DEPTH = 5;

function extractSymbolCandidate(query: string): string {
  const q = query.trim();
  const ident = q.match(/[A-Za-z_$][\w$]*/g);
  if (!ident?.length) return q;
  return ident[ident.length - 1] ?? q;
}

function wantsCallers(query: string): boolean {
  const q = query.toLowerCase();
  return CALLER_PHRASES.some((p) => q.includes(p));
}

function wantsImports(query: string): boolean {
  const q = query.toLowerCase();
  return IMPORT_PHRASES.some((p) => q.includes(p));
}

type GraphNodeOut = {
  id: string;
  label: string;
  type?: string;
  path?: string;
  file?: string;
  line?: number;
  kind?: string;
};

type GraphEdgeOut = {
  from: string;
  to: string;
  label?: string;
  type?: string;
  inferred?: boolean;
};

function collectSymbolEdges(blueprint: Blueprint): SymbolEdge[] {
  const edges: SymbolEdge[] = [];
  const seen = new Set<string>();
  for (const room of blueprint.rooms) {
    for (const fe of room.flowEdges ?? []) {
      const key = `${fe.from}->${fe.to}:${fe.type ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: fe.from, to: fe.to, type: fe.type, label: fe.label });
    }
  }
  return edges;
}

export async function queryStructuralGraph(args: {
  query: string;
  workspaceId: number;
  scopePath?: string;
  maxResults: number;
  depth?: number;
}): Promise<{ summary: string; nodes: GraphNodeOut[]; edges: GraphEdgeOut[] }> {
  const blueprint = await ensureBlueprintParsed(args.workspaceId);
  const symbolIndex = await ensureSymbolIndexForWorkspaceId(args.workspaceId);

  const candidate = extractSymbolCandidate(args.query);
  const symbols = symbolIndex
    ? findSymbolsByName(symbolIndex, candidate, { limit: 10 })
    : [];

  const symbolEdges = collectSymbolEdges(blueprint);
  const nodesOut = new Map<string, GraphNodeOut>();
  const edgesOut: GraphEdgeOut[] = [];

  const addSymbolNode = (s: SymbolIndexCache["symbols"][0]) => {
    nodesOut.set(s.id, {
      id: s.id,
      label: s.name,
      path: s.path,
      file: s.path,
      line: s.line,
      kind: s.kind,
    });
  };

  const addSymbolById = (id: string) => {
    const s = symbolIndex?.symbols.find((sym) => sym.id === id);
    if (s) addSymbolNode(s);
    else {
      for (const room of blueprint.rooms) {
        const fn = room.functions?.find((f) => f.id === id);
        if (fn) {
          nodesOut.set(id, {
            id,
            label: fn.name,
            file: fn.file,
            path: room.path,
          });
          return;
        }
      }
    }
  };

  const addRoomNode = (room: Blueprint["rooms"][0]) => {
    nodesOut.set(room.id, {
      id: room.id,
      label: room.label,
      type: room.type,
      path: room.path,
    });
  };

  const bfsDepth = Math.min(MAX_BFS_DEPTH, Math.max(1, args.depth ?? DEFAULT_BFS_DEPTH));

  if (symbols.length > 0 && (wantsCallers(args.query) || wantsImports(args.query))) {
    const target = symbols[0];
    addSymbolNode(target);

    const edgeTypes = wantsCallers(args.query)
      ? new Set(["call", "calls"])
      : new Set(["import", "imports"]);

    const bfs = bfsSymbolGraph([target.id], symbolEdges, {
      direction: wantsCallers(args.query) ? "reverse" : "forward",
      edgeTypes,
      maxDepth: bfsDepth,
      maxNodes: args.maxResults,
    });

    for (const e of bfs.edges) {
      edgesOut.push({ from: e.from, to: e.to, label: e.label, type: e.type });
    }
    for (const id of bfs.nodes) {
      addSymbolById(id);
    }

    const summary =
      edgesOut.length > 0
        ? `Structural BFS (depth ${bfs.depth}): ${nodesOut.size} node(s), ${edgesOut.length} edge(s) for "${args.query}" targeting \`${target.name}\`.`
        : `No ${wantsCallers(args.query) ? "callers" : "import edges"} found for \`${target.name}\` within depth ${bfsDepth}.`;
    return {
      summary,
      nodes: [...nodesOut.values()].slice(0, args.maxResults),
      edges: edgesOut.slice(0, args.maxResults * 2),
    };
  }

  if (symbols.length > 0) {
    for (const s of symbols.slice(0, args.maxResults)) {
      addSymbolNode(s);
      const room = blueprint.rooms.find((r) => r.functions?.some((f) => f.id === s.id));
      if (room) addRoomNode(room);
    }
  } else {
    const q = args.query.toLowerCase();
    for (const room of blueprint.rooms) {
      if (args.scopePath) {
        const sp = args.scopePath.replace(/\\/g, "/").toLowerCase();
        const rp = (room.path ?? "").toLowerCase();
        if (rp !== sp && !rp.startsWith(`${sp}/`)) continue;
      }
      const hay = `${room.label} ${room.intent ?? ""} ${room.path ?? ""}`.toLowerCase();
      if (hay.includes(q) || (room.functions ?? []).some((fn) => fn.name.toLowerCase().includes(q))) {
        addRoomNode(room);
        for (const fn of (room.functions ?? []).slice(0, 20)) {
          nodesOut.set(fn.id, {
            id: fn.id,
            label: fn.name,
            file: fn.file,
            path: room.path,
          });
        }
      }
    }
  }

  const nodes = [...nodesOut.values()].slice(0, args.maxResults);
  const edges = edgesOut.slice(0, args.maxResults * 2);

  const summary =
    nodes.length === 0
      ? `No structural matches for "${args.query}"${args.scopePath ? ` under ${args.scopePath}` : ""}. Try search(mode:text) or get_blueprint.`
      : `Structural graph: ${nodes.length} node(s), ${edges.length} edge(s) for "${args.query}".`;

  return { summary, nodes, edges };
}
