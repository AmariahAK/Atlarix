# Atlarix RTE, Blueprint, and Search Stack — Technical Reference

**Version:** Atlarix v8.7.5  
**Last updated:** 2026-05-24  
**Audience:** Engineers reverse-engineering or extending Atlarix’s Live Code Map (Blueprint), Reverse-Tooling Engine (RTE), and unified `search` tool.

This document describes the **current production stack** as implemented in the Atlarix desktop app (`Atlarix/` repository). It replaces the pre-v8.6 path built on oxc-parser, tree-sitter WASM, and per-language RTE parsers.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Design goals and constraints](#2-design-goals-and-constraints)
3. [End-to-end data flow](#3-end-to-end-data-flow)
4. [Trigger graph — when parsing runs](#4-trigger-graph--when-parsing-runs)
5. [Project file discovery](#5-project-file-discovery)
6. [Universal Ctags symbol index](#6-universal-ctags-symbol-index)
7. [ast-grep structural scan](#7-ast-grep-structural-scan)
8. [`generateBlueprint()` pipeline](#8-generateblueprint-pipeline)
9. [RTE → Blueprint graph conversion](#9-rte--blueprint-graph-conversion)
10. [Disk cache and `inferBlueprint` sequence](#10-disk-cache-and-inferblueprint-sequence)
11. [Incremental updates (file watcher)](#11-incremental-updates-file-watcher)
12. [Model-facing serialization](#12-model-facing-serialization)
13. [`get_blueprint` tool contract](#13-get_blueprint-tool-contract)
14. [Unified `search` tool](#14-unified-search-tool)
15. [Improved grep / ripgrep layer (deep dive)](#15-improved-grep--ripgrep-layer-deep-dive)
16. [BM25 semantic-graph search](#16-bm25-semantic-graph-search)
17. [Structural BFS search](#17-structural-bfs-search)
18. [Blast radius analysis](#18-blast-radius-analysis)
19. [Extensions, native deps, and build hooks](#19-extensions-native-deps-and-build-hooks)
20. [Accuracy, speed, and tradeoffs](#20-accuracy-speed-and-tradeoffs)
21. [Removed stack (v8.6)](#21-removed-stack-v86)
22. [Appendix: key file index](#22-appendix-key-file-index)

---

## 1. Executive summary

Atlarix gives AI agents **structural awareness** of a codebase without injecting the entire repository into every LLM turn. The agent navigates via tools:

| Tool | Purpose |
|------|---------|
| `get_blueprint` | Section-scoped architecture slice (`focus_path` required); Markdown tool-mode + optional raw/graph |
| `search` | Unified search: text (ripgrep), concept (BM25 / file scan), structural (graph BFS) |
| `get_file_outline` | Per-file symbol TOC (ctags-backed) |
| `get_diagram` | Mermaid from on-demand codebase scan (no stale DB snapshot); **inline ` ```mermaid ` fences in chat** are the primary diagram UX |

**Index stack (v8.6+):**

| Layer | Engine | Role |
|-------|--------|------|
| Symbol index | **Universal Ctags** (bundled per platform) | Functions, classes, types — line-accurate beacons |
| Structural graph | **@ast-grep/napi** | Import, call, HTTP route edges (TS/JS/TSX, Python, Go) |
| Natural language | **BM25** (`wink-bm25-text-search`) | Ranks ctags symbols by concept query |
| Text fallback | **ripgrep** (`rg`) | Exact string / pattern search |

**Fallback chain for Blueprint generation:**

```
RTE disk cache → generateBlueprint (ctags + ast-grep) → file-tree bridge → workspace analysis → empty blueprint
```

Nothing runs on workspace open. Parsing is **lazy** and **single-flight** per workspace.

---

## 2. Design goals and constraints

### 2.1 Token budget

The model must not receive hundreds of thousands of tokens of raw source on every turn. Blueprint and search tools return **focused slices**:

- `get_blueprint` defaults to Markdown-only output capped at ~300–500 lines (`blueprintToMarkdown` default `maxLines: 500`; tool layer may apply additional caps).
- `search` truncates formatted output by UTF-8 byte budget (default 120,000 bytes).
- Structural and BM25 results return ranked hits with line context, not whole files.

### 2.2 Lazy evaluation

From `lazy-parse.ts`:

> Workspace open does NOT trigger any Blueprint parse. Parsing only happens when:
> 1. The model calls `get_blueprint` (or `include_panel_graph`).
> 2. The model calls `search` with `mode: "structural"` or `mode: "semantic-graph"`.
> 3. IPC such as `blueprint:refresh-from-code` or snapshot handlers (user-initiated).

File discovery (`getProjectFiles`) is similarly lazy — only when a tool or handler needs the file list.

### 2.3 Single-flight deduplication

Concurrent callers to `ensureBlueprintParsed(workspaceId)` share one in-flight promise (`inflight` map in `lazy-parse.ts`). Same pattern for `ensureSymbolIndex(projectPath)` in `ctags-index.ts`.

### 2.4 Production logging (v8.7.5+)

Routine Blueprint / ast-grep success paths log at **`debug`** (not `info`): `ensureBlueprintParsed` complete/still-parsing, `runStructuralScan` start/complete, `inferBlueprint: generateBlueprint complete`. **`warn`** and **`error`** are unchanged for real failures (missing scan root, parse timeout, native binding errors).

### 2.5 `.atlarixignore`

Gitignore-syntax exclusions apply to:

- RTE node/edge filtering during cache load and generation
- Blueprint prompt injection boundaries
- Parsed file sets (via ignore-aware filtering)

Default ignore content is ensured by `ensureDefaultAtlarixIgnore()`.

---

## 3. End-to-end data flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MODEL (LLM in workspace chat)                        │
└─────────────────────────────────────────────────────────────────────────────┘
         │ get_blueprint              │ search(mode=...)           │ write_file
         ▼                            ▼                            ▼
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────────┐
│ blueprint.ts    │          │ search.ts       │          │ enrich-blast-radius │
│ tool handler    │          │ tool handler    │          │ (permission meta)   │
└────────┬────────┘          └────────┬────────┘          └──────────┬──────────┘
         │ validateBlueprintFocusPath │
         ▼                            ▼                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ensureBlueprintParsed(workspaceId)  │  resolveSearchMode + engines       │
│         │                           │         │                          │
│         ▼                           │    text → ripgrep                  │
│ getBlueprintForWorkspace            │    semantic-lite → file scan       │
│         │                           │    semantic-graph → BM25           │
│         ▼                           │    structural → graph BFS          │
│ inferBlueprint                      │                                    │
│   1. loadBlueprintCache             │                                    │
│   2. generateBlueprint              │                                    │
│   3. file-tree bridge               │                                    │
│   4. workspace analysis             │                                    │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ generateBlueprint(projectPath)                                               │
│   ensureDefaultAtlarixIgnore → detectLanguage → ensureSymbolIndex          │
│   getProjectFiles → runStructuralScan → filter by ignore → RTE result      │
└─────────────────────────────────────────────────────────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌─────────┐ ┌──────────────────┐
│ ctags   │ │ ast-grep scan    │
│ symbols │ │ imports/calls/   │
│ .atlarix│ │ routes           │
│/symbols │ │ worker pool or   │
│ .json   │ │ in-process batch │
└─────────┘ └──────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ rteResultToBlueprint → Blueprint { rooms, edges, flowEdges per room }        │
│ assessBlueprintRichness → supplementThinRteResult (hybrid) if thin           │
│ mergeBlueprintWithFileTree when not rich                                     │
│ buildSliceWithResolve(focus_path, scope default full)                        │
│ blueprintToMarkdown(toolMode) → model-readable text                          │
│ saveBlueprintCache (skip when 0 visible rooms)                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 v8.7 additions (section path, slice, errors)

| Stage | Module | Behavior |
|-------|--------|----------|
| Path preflight | `section-path.ts` | `focus_path` must exist under workspace; typos return Levenshtein suggestions (`success: false`) |
| Slice | `blueprint-slice.ts` | `resolveSliceParams` + `buildSliceWithResolve`; default `scope: "full"`; auto-widen empty narrow slices |
| Richness | `blueprint-quality.ts` | `assessBlueprintRichness`, `isThinRteNodeSet` |
| Hybrid merge | `blueprint-merge.ts`, `rte-supplement.ts` | File-tree backfill when graph is thin; engine `hybrid` |
| Serialization | `blueprint-markdown.ts` | `toolMode` compact exports; `emptyReason`: `unparsed` \| `slice_empty` \| `topic_filter` |
| Cache policy | `blueprint_handlers.ts` | Do not cache parses with zero visible rooms |

---

## 4. Trigger graph — when parsing runs

| Trigger | Entry point | File |
|---------|-------------|------|
| Model calls `get_blueprint` | `ensureBlueprintParsed` → `getBlueprintForWorkspace` | `src/lib/tools/blueprint.ts`, `src/lib/blueprint/lazy-parse.ts` |
| Model calls `search(structural)` | `queryStructuralGraph` → `ensureBlueprintParsed` | `src/lib/search/structural-graph-query.ts` |
| Model calls `search(semantic-graph)` | `searchBlueprintBm25` → `ensureSymbolIndex` (may lazy-load blueprint as BM25 fallback) | `src/lib/search/bm25_semantic_index.ts` |
| User IPC refresh | `blueprint:refresh-from-code` | `src/ipc/handlers/blueprint_handlers.ts` |
| File save (watcher) | `registerBlueprintFileWatcher` → `updateBlueprintCacheForFiles` | `src/lib/blueprint/blueprint-file-watcher.ts` |
| First `generateBlueprint` | Full ctags + ast-grep scan | `src/lib/blueprint/rte/parsers/index.ts` |

**Not triggered on:** workspace open, chat start, or every message.

---

## 5. Project file discovery

**Source:** `Atlarix/src/ipc/utils/project-files.ts`

### 5.1 Four-strategy cascade

1. **`git ls-files`** (primary) — respects project `.gitignore`
2. **`fd`** (fallback) — cross-platform, respects `.gitignore`
3. **`ripgrep --files`** (fallback) — also respects `.gitignore`
4. **`getFilesRecursively`** (last resort) — legacy walk with manual exclusions

Returns `ProjectFilesResult`:

```typescript
interface ProjectFilesResult {
  files: string[];           // workspace-relative paths
  strategy: "git" | "fd" | "ripgrep" | "fallback";
  count: number;
  accessWarnings?: string[];
}
```

### 5.2 Caching

- In-memory cache per workspace: **5 minute TTL** (`FILE_LIST_TTL_MS = 5 * 60 * 1000`).
- Structure scan cache: same 5 minute TTL.

### 5.3 Hard exclusions

Always excluded directory names include: `node_modules`, `.git`, `dist`, `build`, `.next`, `__pycache__`, `.venv`, `target`, `vendor`, CDK asset hex segments, etc.

`isExcludedDiscoveryRelPath()` filters CDK/SAM deployment artifact paths.

### 5.4 Role in RTE

Both `ensureSymbolIndex` and `runStructuralScan` call `getProjectFiles(projectPath)` to obtain the authoritative file list before ctags and ast-grep run.

---

## 6. Universal Ctags symbol index

**Source:** `Atlarix/src/lib/index/ctags-index.ts`, `ctags-parse.ts`, `symbol-types.ts`  
**Native binary:** resolved by `resolveCtagsPath()`; installed via `scripts/fetch-ctags.mjs` (postinstall).

### 6.1 Supported extensions

```typescript
const CTAGS_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".cs", ".rb", ".php", ".swift", ".ex", ".exs",
  ".vue", ".svelte",
]);
```

Note: ast-grep structural edges only run on a **subset** (TS/JS/TSX, Python, Go) — see §7. Ctags still indexes Rust, Java, etc. for symbols and BM25.

### 6.2 Symbol record schema

```typescript
type SymbolRecord = {
  id: string;        // Stable hash(path + name + line + kind)
  name: string;
  kind: string;      // Ctags kind letter or long name (f, c, m, function, class, …)
  path: string;      // Workspace-relative file path
  line: number;
  endLine?: number;
  scope?: string;
  signature?: string;
};
```

### 6.3 On-disk cache

**Path:** `<projectRoot>/.atlarix/symbols.json`

```typescript
type SymbolIndexCache = {
  manifest: {
    projectPath: string;
    timestamp: number;
    fileCount: number;
    symbolCount: number;
    commitHash?: string | null;
    ctagsVersion?: string;
    engine: "ctags";
  };
  symbols: SymbolRecord[];
};
```

### 6.4 Staleness

Cache is stale when:

1. Path is in `dirtyPaths` set (`invalidateSymbolIndex`, `markSymbolIndexDirty`), or
2. Git HEAD commit hash differs from `manifest.commitHash` (when both are available).

### 6.5 `ensureSymbolIndex(projectPath)`

1. Return memory cache if warm and not dirty.
2. Load disk cache if not stale.
3. Otherwise single-flight build:
   - `getProjectFiles` → filter by `CTAGS_EXTENSIONS`
   - Write file list to `.atlarix/.ctags-filelist`
   - Run ctags: `--output-format=json --fields=+nKlzS --extras=+q -f - -L <list>`
   - Parse JSON via `parseCtagsJsonOutput`
   - Save to `.atlarix/symbols.json`
   - Store in memory map

**Timeouts:** ctags version check 5s; main run 120s; maxBuffer 100MB.

### 6.6 Incremental: `updateSymbolIndexForFile(projectPath, relFile)`

Used by the file watcher / incremental blueprint path:

1. Load existing cache (or empty shell).
2. Remove all symbols where `path === relFile`.
3. If file exists and extension is supported, re-run ctags on **that file only**.
4. Merge new symbols, update manifest counts and commit hash.
5. Save disk + memory cache.

This avoids full-project ctags on every keystroke.

### 6.7 `isSymbolIndexWarm(projectPath)`

Returns `true` when disk/memory cache has symbols and is not stale. Used by `search` auto-mode to upgrade `semantic-lite` → `semantic-graph` (BM25).

### 6.8 Query helpers

- `getSymbolsForFile(cache, relPath)` — symbols in one file
- `findSymbolsByName(cache, name, { kind?, limit? })` — case-insensitive name match for structural search and blast radius

---

## 7. ast-grep structural scan

**Sources:**  
- `Atlarix/src/lib/blueprint/rte/ast-grep/run-structural-scan.ts`  
- `Atlarix/src/lib/blueprint/rte/ast-grep/scan-file-edges.ts`  
- `Atlarix/src/lib/blueprint/rte/ast-grep/rules/{imports,calls,routes}.ts`  
- `Atlarix/src/lib/blueprint/rte/ast-grep/worker-pool.ts`  
- `Atlarix/workers/blueprint/astgrep_worker.ts`

### 7.1 Language map

**File:** `lang-map.ts`

| Extension | ast-grep language |
|-----------|-------------------|
| `.ts` | `Lang.TypeScript` |
| `.tsx` | `Lang.Tsx` |
| `.js`, `.jsx`, `.mjs`, `.cjs` | `Lang.JavaScript` |
| `.py` | dynamic `"python"` |
| `.go` | dynamic `"go"` |

Python and Go require `ensureAstGrepDynamicLangs()` which registers `@ast-grep/lang-python` and `@ast-grep/lang-go` tree-sitter grammars via `registerDynamicLanguage()`.

### 7.2 Edge types extracted

| Type | Source | Description |
|------|--------|-------------|
| `imports` | `scanImportsForFile` | Module/file import relationships |
| `calls` | `scanCallsForFile` | Function/method call edges |
| `api_call` | `scanRoutesForFile` | HTTP route handlers |

### 7.3 Import resolution

For each import capture from ast-grep patterns (`importPatterns(lang)`):

1. Strip quotes from captured path.
2. `resolveRelativeImport(imp, relFile, projectRoot)` resolves to workspace-relative target file.
3. `from` node: symbol in current file at line, or module pseudo-node via `nodeIdForFileLine`.
4. `to` node: first symbol in target file, or module pseudo-node.

### 7.4 Call resolution

For each call capture (`callPatterns(lang)`):

1. Extract callee identifier (must match `/^[a-zA-Z_$][\w$]*$/`).
2. Determine caller symbol by line range (`callerSymbols.find(s => s.line <= line && (s.endLine ?? s.line) >= line)`).
3. Search **all files** in symbol lookup for matching `name === callee`.
4. Dedupe by `fromId->toId`.

**Accuracy note:** Call edges are resolved by **global name match**, not scope-aware symbol tables. Common names may produce false-positive edges; unique names resolve well.

### 7.5 Route edges

`scanRoutesForFile` uses `routePatternSpecs(lang)`:

- **Express/Fastify:** `app.get/post/...('path', handler)` patterns
- **Next.js App Router:** `export async function GET/POST/...` in `app/**/route.ts`
- **Next.js Pages:** inferred from `pages/**` file paths

Route target nodes are synthetic: `nodeIdForFileLine(relFile, line, 'route:METHOD:path')`.

`inferNextRoutePath(relFile)` derives URL path from file location for App/Pages router conventions.

### 7.6 Full scan: `runStructuralScan`

Constants:

```typescript
const MAX_FILES_PER_SCAN = 5000;
const CONCURRENCY = 4;           // in-process fallback
const WORKER_BATCH_SIZE = 25;    // worker pool batches
```

Flow:

1. `nodes = symbolsToNodes(symbols)` — all ctags symbols become RTE nodes.
2. Filter files with `isAstGrepSupportedPath`.
3. If worker pool available: batch `scanBatchInWorker` (25 files per batch).
4. Else: `runBatch` with concurrency 4 calling `scanFileStructuralEdges` per file.
5. Dedupe edges by `from->to:type` key.

Worker pool built by `npm run build:astgrep-worker` → `astgrep_worker.js`; shuts down on app quit.

### 7.7 Per-file scan (incremental)

`scanFileStructuralEdges(projectRoot, relFile, byFile)` runs imports + calls + routes for **one file**. Used by `updateBlueprintCacheForFile`.

---

## 8. `generateBlueprint()` pipeline

**Source:** `Atlarix/src/lib/blueprint/rte/parsers/index.ts`

### 8.1 Steps

```typescript
export async function generateBlueprint(projectPath: string): Promise<RTEParseResult | null>
```

1. `ensureDefaultAtlarixIgnore(projectPath)`
2. Read `.atlarixignore` → create ignorer
3. `detectLanguage(projectPath)` — checks root for `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, etc.
4. **Try primary path:**
   - `ensureSymbolIndex(projectPath)`
   - `getProjectFiles(projectPath)`
   - `runStructuralScan(projectPath, files, symbolIndex.symbols)`
   - Throw if `nodes.length === 0`
   - Filter nodes/edges by `.atlarixignore`
   - Return `{ nodes, edges, framework, atlarixIgnoreSource }`
5. **On failure:** log and `generateBlueprintFromFileTree` (file-tree bridge — nodes only, **empty edges**)

### 8.2 Engine label

```typescript
function blueprintEngineLabel(result): "ast-grep+ctags" | "file-tree" {
  if (!result?.nodes?.length) return "file-tree";
  return result.edges.length > 0 ? "ast-grep+ctags" : "file-tree";
}
```

Persisted in blueprint cache manifest as `engine`.

### 8.3 File-tree fallback

**Source:** `rte/file-tree-bridge.ts` → `buildBlueprintFromFileTree` from `fileTreeSource.ts`

When ctags or ast-grep fails:

- Builds directory-based “rooms” and regex-derived beacons
- **No structural edges** in fallback RTE result
- Lower confidence (`framework.confidence: 0.5`)

---

## 9. RTE → Blueprint graph conversion

**Source:** `Atlarix/src/lib/blueprint/rte_to_blueprint.ts`

### 9.1 Room clustering

Nodes grouped by `getRoomKey(filePath, projectRoot)`:

- Strip project root → relative path
- If first segment is generic (`src`, `lib`, `app`, `components`, …) and depth > 1, room key = **second** segment
- Else room key = first path segment

Example: `src/lib/auth/session.ts` → room `lib` (because `src` is generic).

### 9.2 Blueprint shape

```typescript
type Blueprint = {
  rooms: BlueprintRoom[];   // clustered containers
  edges: BlueprintEdge[];   // cross-room connections
  envRefs: string[];
};

type BlueprintRoom = {
  id: string;
  label: string;
  path?: string;
  functions?: BlueprintFunction[];
  flowEdges?: BlueprintEdge[];  // symbol-level edges within/across room
  // ...
};
```

RTE flat `nodes` + `edges` map into:

- `functions` on rooms (from ctags symbol nodes)
- `flowEdges` on rooms (import/call/api_call edges)
- Top-level `edges` for room-to-room aggregation

### 9.3 Kind mapping

RTE node types map to `BlueprintFunctionKind` via `RTE_KIND_TO_BLUEPRINT` (api, webhook, function, etc.).

---

## 10. Disk cache and `inferBlueprint` sequence

### 10.1 Blueprint cache

**Source:** `Atlarix/src/lib/cache/blueprint-cache.ts`  
**Types:** `Atlarix/src/shared/blueprint-cache-types.ts`

Stored under project-specific cache (manifest includes `projectHash`, `projectPath`, `engine`, `framework`, `timestamp`).

```typescript
interface BlueprintCacheContent {
  manifest: BlueprintManifest;
  nodes: BlueprintNode[];
  edges: RTEBlueprintEdge[];
  blueprint?: Blueprint;           // legacy UI compatibility
  atlarixIgnoreSource?: string;
}
```

### 10.2 `inferBlueprint(workspaceId)` — ordered fallback

**Source:** `blueprint_handlers.ts`

```
1. loadBlueprintCache(workspacePath)
   → filter by .atlarixignore
   → rteResultToBlueprint
   → if rooms.length > 0: setCachedBlueprint, return

2. generateBlueprint(workspacePath)
   → saveBlueprintCache with engine label
   → rteResultToBlueprint
   → if rooms.length > 0: setCachedBlueprint, return

3. buildBlueprintFromFileTree(workspacePath)
   → setCachedBlueprint(engine: "file-tree"), return

4. analyzeWorkspace / inferBlueprintFromWorkspace
   → return heuristic blueprint or empty
```

### 10.3 `getBlueprintForWorkspace(workspaceId)`

1. In-memory cache hit → sanitize, optionally `mergeInferredEdges`
2. Load `.atlarix/blueprint.json` snapshot if newer (Workforce tier)
3. Else `inferBlueprint`

### 10.4 `mergeInferredEdges`

When cache `engine === "ast-grep+ctags"` and flow/cross-room edges already exist, **skips** file-tree regex edge merge (avoids polluting ast-grep graph with low-quality inferred edges).

---

## 11. Incremental updates (file watcher)

**Sources:**  
- `blueprint-file-watcher.ts`  
- `incremental-update.ts`

### 11.1 Watcher registration

`registerBlueprintFileWatcher(projectPath, workspaceId, onUpdated)`:

- Uses Node.js `fs.watch(projectPath, { recursive: true })`
- Filters to code extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.java`, …)
- **500ms debounce** — batches changed paths in a `Set`
- On fire: `refreshBlueprintCacheFromFileTree(projectPath, batch)`

### 11.2 Per-file cache merge (`updateBlueprintCacheForFile`)

1. If no RTE cache → full `generateBlueprint` (same as cold start).
2. `updateSymbolIndexForFile` for changed file.
3. Remove old nodes/edges touching that file’s node IDs.
4. If file still exists:
   - Add new symbol nodes from updated ctags
   - `scanFileStructuralEdges` for new edges
5. `saveBlueprintCache` with updated nodes/edges.
6. `invalidateBm25Index(workspaceId)` so next semantic search rebuilds BM25.

### 11.3 Complexity

- **Full scan:** O(files) ctags + O(ast-grep files) structural — seconds on large repos.
- **Incremental:** O(1) ctags per changed file + O(1) ast-grep per changed file — milliseconds typical.

---

## 12. Model-facing serialization

**Source:** `Atlarix/src/lib/blueprint/blueprint-markdown.ts`

### 12.1 Markdown tree format

`blueprintToMarkdown(blueprint, options)` produces top-down Markdown:

- H1 workspace title
- H2/H3 room hierarchy by directory
- Function lists under rooms with file:line
- Cross-cutting edges as `[[type: target]]` beneath source nodes

Options:

```typescript
interface BlueprintMarkdownOptions {
  maxLines?: number;        // default 500; tail replaced with truncation note
  includeImports?: boolean;
  includeExports?: boolean;
  workspaceName?: string;
}
```

### 12.2 Why Markdown for the model

- LLMs parse hierarchical text efficiently
- Line caps prevent context blow-up
- Edge notation is plain-text searchable in follow-up turns
- Optional `include_raw: true` on `get_blueprint` adds JSON nodes/edges slice for structured reasoning

---

## 13. `get_blueprint` tool contract

**Source:** `Atlarix/src/lib/tools/blueprint.ts`  
**Agent guide:** `Atlarix/src/skills/guides/blueprint-section-first.md`

### 13.1 Parameters

| Param | Default | Description |
|-------|---------|-------------|
| **`focus_path`** | **required** | Workspace-relative folder to parse and slice (e.g. `packages/api`, `backend`) |
| `scope` | `full` | `file` \| `folder` \| `full` — within the focused section |
| `path` | — | Room-relative path for `file` / `folder` scope |
| `topic` | — | Optional keyword filter on room labels / exports |
| `depth` | `2` | Edge hops when expanding folder slices (0–5) |
| `include_raw` | `false` | JSON nodes/edges slice |
| `include_panel_graph` | `false` | Normalized graph for UI panel |
| `graph` | auto when thin | Force graph-oriented output |

### 13.2 Handler flow (v8.7)

1. **`validateBlueprintFocusPath(workspaceRoot, focus_path)`** — on failure: `success: false`, `suggestions[]`, no parse
2. **`ensureBlueprintParsed(workspaceId, { scanRoot: focus_path })`** — infer chain scoped to section
3. On valid path with 0 rooms after parse: `success: false` with actionable message (not cached)
4. **`filterBlueprintByTopic`** (optional)
5. **`buildSliceWithResolve`** — default full section; sets `sliceWidened` when auto-widened
6. **`blueprintToMarkdown(slice, { toolMode: true })`** — primary payload
7. Metadata: `parseQuality` (`rich` \| `thin`), `parseEngine`, `parsedRoomCount`, `emptyReason` when applicable
8. Optional raw slice / panel graph

### 13.3 Error surfaces

| Condition | Result |
|-----------|--------|
| Missing / non-directory `focus_path` | Preflight error + suggestions |
| Valid path, 0 rooms after parse | Error (indexing/ignore); not cached |
| Narrow slice matches nothing | Auto-widen to full section or `emptyReason: slice_empty` |
| `topic` filter excludes all rooms | `emptyReason: topic_filter` |
| Workspace never parsed | `emptyReason: unparsed` |

### 13.4 Cost and mode

- `cost: 3` (higher than search)
- Read-only, allowed in Ask mode
- **Not injected automatically** into system prompt (v8.1.1+); model must call tool

---

## 14. Unified `search` tool

**Sources:**  
- `Atlarix/src/lib/tools/search.ts`  
- `Atlarix/src/lib/search/search-mode-routing.ts`

### 14.1 Modes

| Input mode | Resolved engine | Backend |
|------------|-----------------|---------|
| `auto` | detected | see §14.2 |
| `text` | `ripgrep` | `searchCodeByText` |
| `semantic-lite` | `file_scan` | keyword line relevance scan |
| `semantic-graph` | `bm25_ctags` | BM25 over symbols, fallback semantic-lite |
| `structural` | `ast_grep_graph` | `queryStructuralGraph` + lazy blueprint |
| `semantic` (legacy) | → `semantic-graph` | alias |

### 14.2 Auto-mode detection

**File:** `search-mode-routing.ts`

Priority order in `detectAutoSearchMode(query)`:

1. **Structural** if query contains phrases like:
   - `"what calls"`, `"who calls"`, `"callers of"`
   - `"what imports"`, `"dependencies of"`, `"reverse dependencies"`, etc.

2. **Semantic-lite** if query contains:
   - `"how does"`, `"where is"`, `"error handling"`, `"auth flow"`, `"concept"`, etc.

3. **Default: text** (ripgrep)

**Upgrade:** If auto detected `semantic-lite` AND `isSymbolIndexWarm(workspacePath)`, resolve to **`semantic-graph`** (BM25).

Structural phrases require multi-word patterns deliberately — avoids `"imports"` alone triggering graph mode.

### 14.3 Response shape

Every successful search returns:

```typescript
{
  success: true,
  requested_mode: string,
  resolved_mode: SearchResolvedMode,
  engine: string,        // ripgrep | file_scan | bm25_ctags | ast_grep_graph
  mode: SearchResolvedMode,
  result?: string,       // text / semantic modes
  summary?: string,      // structural mode
  nodes?: [...],
  edges?: [...],
}
```

`_onSearchRouting` callback emits `requested=X resolved=Y engine=Z` for Activity/debug UI.

---

## 15. Improved grep / ripgrep layer (deep dive)

The unified `search` tool’s **text mode** and auto-mode text fallback use a structured ripgrep wrapper in `search.ts` (formerly split helpers, now inlined).

### 15.1 `runRipgrepSearch`

```typescript
async function runRipgrepSearch(args: {
  pattern: string;
  workspace: string;
  contextLines: number;
  filePattern?: string;
  caseSensitive: boolean;
}): Promise<GrepGroup[]>
```

**Command construction:**

```bash
rg "<escaped-pattern>" "<workspace>" -n -C <contextLines> [-i] [-g "<glob>"]
```

- Pattern quotes escaped: `pattern.replace(/"/g, '\\"')`
- `-33 `-n` line numbers, `-C` context lines (0–10, default 2)
- Case-insensitive unless `caseSensitive: true`
- Optional `-g` glob from `pathToRipgrepGlob(scopePath)`

**Buffer:** `maxBuffer: 10 * 1024 * 1024` (10MB stdout).

**Failure behavior:** catch → return `[]` (caller formats as “No matches”).

### 15.2 `searchCodeByText`

1. If not regex mode: escape metacharacters  
   `query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`
2. Call `runRipgrepSearch`
3. Trim to `maxResults` (default 50, tool max 200) across files:
   - Iterate groups, slice matches per file until budget exhausted

### 15.3 `parseGrepOutput`

Parses ripgrep `file:line:content` lines into:

```typescript
type GrepGroup = {
  file: string;
  matches: { line: number; content: string }[];
};
```

Groups consecutive lines by file. Skips malformed lines.

### 15.4 `formatGrepGroupsForDisplay`

- Header: `Found N match(es) for "query" across M file(s):`
- Per file: `📄 path` then `  line: content`
- **Per-file cap:** `perFileCap` default 30, max 100
- **`truncateUtf8ByBytes`:** default max 120,000 UTF-8 bytes; shaves tail with notice:
  `… [search output truncated by max_bytes; narrow path or lower max_results]`

### 15.5 Scoped search: `pathToRipgrepGlob`

```typescript
function pathToRipgrepGlob(scopePath?: string): string | undefined {
  if (!scopePath) return undefined;
  const p = scopePath.replace(/^\//, "").replace(/\\/g, "/");
  if (p.includes("*")) return p;
  if (/\.[a-zA-Z0-9]{1,8}$/.test(p)) return `**/${p}`;      // single file
  return `**/${p}/**`;                                         // directory
}
```

Passed as ripgrep `-g` glob — limits search to subtree without walking ignored dirs manually.

### 15.6 Contrast with semantic-lite

| Aspect | Text (ripgrep) | Semantic-lite |
|--------|----------------|---------------|
| Index required | No | No |
| Match logic | Exact/substring via rg | Keyword scoring per line |
| File discovery | rg respects gitignore | Recursive `readdir` scan |
| Extensions | all rg-indexed files | `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.java`, `.go`, `.rs` |
| Context | rg `-C` context lines | ±3 lines around hit |
| Speed | Fast (native rg) | Slow on large repos (JS walk) |
| Best for | symbols, strings, TODOs | concept questions when BM25 cold |

### 15.7 Contrast with semantic-graph (BM25)

| Aspect | ripgrep | BM25 |
|--------|---------|------|
| Query type | literal / regex | natural language concepts |
| Index build | none | first query builds in-memory BM25 over ctags docs |
| Ranking | match order | BM25 score |
| Warm index | N/A | requires `.atlarix/symbols.json` warm |
| Fallback | empty results | semantic-lite file scan |

### 15.8 When the model should use which mode

System prompt guidance (`system_prompt.ts`):

> Use `search` (mode: auto | text | semantic | structural) and `get_file_outline`, then `read_file` only for exact ranges.

**Practical routing:**

- Known string / error message → `text` or `auto` (likely text)
- “How does auth work?” → `auto` → semantic-lite or BM25 if warm
- “What calls handleLogin?” → `auto` → structural (phrase match)
- Graph exploration without phrase → explicit `structural` or `get_blueprint`

---

## 16. BM25 semantic-graph search

**Source:** `Atlarix/src/lib/search/bm25_semantic_index.ts`

### 16.1 Document construction

Primary path (ctags available):

For each symbol:

```typescript
{
  name: s.name,           // weight 4
  kind: s.kind,           // weight 1
  scope: s.scope,         // weight 1
  path: s.path,           // weight 1
  signature: s.signature, // weight 2
  snippet: line at s.line // weight 2, max 4000 chars
}
```

Fallback (no symbols): lazy-load full blueprint, index beacon nodes via `blueprintToRagGraph`.

### 16.2 Tokenization

```typescript
text.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 1)
```

### 16.3 Cache lifecycle

- In-memory `indexByWorkspaceId` map
- Invalidated on: symbol index dirty, blueprint file watcher refresh (`invalidateBm25Index`)
- Stale when git HEAD ≠ cached `commitHash`

### 16.4 Search

```typescript
raw = cached.engine.search(query.trim(), scanLimit);
// scanLimit = max(maxResults, 200)
```

Hits enriched with ±3 line context via `enrichLineContext`.

Formatted via `formatSemanticHitsAsText` — same visual style as semantic-lite (`file:line`, `> line| content`).

---

## 17. Structural BFS search

**Sources:**  
- `structural-graph-query.ts`  
- `graph-bfs.ts`

### 17.1 Entry: `queryStructuralGraph`

1. `ensureBlueprintParsed(workspaceId)`
2. `ensureSymbolIndexForWorkspaceId(workspaceId)`
3. Extract symbol candidate from query (last identifier token)
4. `findSymbolsByName` (limit 10)

### 17.2 Phrase-directed BFS

If query matches caller/import phrases AND symbols found:

- Collect `flowEdges` from all blueprint rooms → `symbolEdges`
- Run `bfsSymbolGraph` with:
  - `direction: reverse` for callers, `forward` for imports
  - `edgeTypes: {call, calls}` or `{import, imports}`
  - `maxDepth`: 1–5 (default 2)
  - `maxNodes`: maxResults

Returns `{ summary, nodes[], edges[] }`.

### 17.3 `bfsSymbolGraph` algorithm

Classic BFS layered by depth:

- `visited` set seeded with start IDs
- Each layer: for each frontier node, scan all edges matching direction/type
- Forward: follow `from → to`; Reverse: follow `to → from`
- Stop at `maxDepth` or `maxNodes`

Edge type normalization: `imports` → `import` for matching.

### 17.4 Fallback without phrase match

Room/function name substring search over blueprint when no symbol hit — useful for “auth module” style queries.

---

## 18. Blast radius analysis

**Sources:**  
- `blast-radius.ts`  
- `enrich-blast-radius.ts`  
- wired from `shell.ts` (`diagnose_issue` `change_impact`) and permission interceptor

### 18.1 Purpose

Before approving `write_file` / `edit_file`, show **estimated impact**: callers, importers, downstream callees affected by editing a file.

### 18.2 `analyzeBlastRadius`

Inputs: `projectPath`, `filepath`, optional `workspaceId`, `maxDepth` (default 3), `maxNodes` (default 80).

Steps:

1. `ensureSymbolIndex` → symbols in target file
2. `loadBlueprintForAnalysis` → parsed blueprint or RTE cache
3. Collect `flowEdges` → `symbolEdges`
4. BFS reverse on call/api edges → **callers**
5. BFS reverse on import edges → **importers**
6. BFS forward on call/api edges → **callees**
7. Compute `impactLevel`:
   - `low`: callers + importers < 5
   - `medium`: 5–14
   - `high`: ≥ 15

### 18.3 Permission metadata

```typescript
{
  estimatedImpact: string,  // human summary
  affectedFiles: string[],  // excluding target file
}
```

### 18.4 Autonomous skip

`enrichPermissionWithBlastRadius` returns `undefined` when `shouldAutoApprovePermissions(agentMode, chatSessionId)` — autonomous mode must not block on graph analysis or show approval UI.

### 18.5 Unknown impact cases

- No symbols in file → “blast radius unknown (ctags may be warming)”
- No flow edges → “run get_blueprint or refresh-from-code for graph-backed impact”

---

## 19. Extensions, native deps, and build hooks

### 19.1 npm packages

| Package | Role |
|---------|------|
| `@ast-grep/napi` | Structural pattern matching |
| `@ast-grep/lang-python` | Python tree-sitter grammar |
| `@ast-grep/lang-go` | Go tree-sitter grammar |
| `wink-bm25-text-search` | BM25 index |
| `electron-log` | Scoped logging (`ctags-index`, `ast-grep-structural`, etc.) |

### 19.2 Bundled native: Universal Ctags

**Script:** `scripts/fetch-ctags.mjs`  
**Hook:** `postinstall` in `package.json`:

```json
"postinstall": "patch-package && node node_modules/electron/install.js && node scripts/fetch-ctags.mjs && npm run build:astgrep-worker || true",
"fetch-ctags": "node scripts/fetch-ctags.mjs",
"build:astgrep-worker": "vite build --config vite.astgrep-worker.config.mts",
"prestart": "npm run build:astgrep-worker"
```

Platform binaries cached under app resources; resolved at runtime via `resolveCtagsPath()`.

### 19.3 External CLI dependencies

| CLI | Required | Fallback if missing |
|-----|----------|---------------------|
| `rg` (ripgrep) | Expected on dev machines | Empty grep results |
| `git` | Optional | Next discovery strategy |
| `fd` | Optional | ripgrep --files |
| `ctags` | Bundled | file-tree blueprint fallback |

### 19.4 CI

Release workflow (`.github/workflows/release.yml`) triggers on tag `v*`. CI runs `fetch-ctags` before builds and `bench-blueprint-index.ts` (replaces old parser bench).

### 19.5 Packaged desktop (Electron)

Production builds must ship ast-grep natives and grammars outside the main asar slice:

| Asset | Packaging |
|-------|-----------|
| Python / Go `parser.so` | Forge **`extraResource`** → `Resources/ast-grep-grammars/{python,go}/parser.so` |
| `@ast-grep/napi-*` platform binding | **`asarUnpack`** globs + `rebuild` `extraModules` |
| Worker | `astgrep_worker.js` unpacked beside natives |

**Runtime resolution** ([`register-dynamic-langs.ts`](../src/lib/blueprint/rte/ast-grep/register-dynamic-langs.ts)): `extraResource` grammars → `app.asar.unpacked` → dev `node_modules`.

**Do not** run post-install `npm prune --omit=optional` after ast-grep install — it strips optional platform `@ast-grep/napi-*` packages and causes `Cannot find native binding` in packaged apps.

**Verify after package:** `npm run package:verify` (runs `verify-astgrep-packaged.mjs` for napi `.node` and grammar paths).

---

## 20. Accuracy, speed, and tradeoffs

### 20.1 Symbol accuracy (ctags)

**Strengths:**

- Line-accurate definitions across many languages
- Battle-tested Universal Ctags kind taxonomy
- Incremental per-file refresh keeps index current

**Limits:**

- Macro-generated code may miss symbols
- JSX/template edge cases depend on ctags build
- No type-level graph (generics, interfaces) — names only

### 20.2 Structural edge accuracy (ast-grep)

**Strengths:**

- Real AST import/call patterns for TS/JS/TSX/Python/Go
- HTTP route extraction for Express/Fastify/Next
- Worker pool amortizes process isolation overhead

**Limits:**

- Call edges: global name match, not scope-aware
- Dynamic imports / re-exports partially resolved
- MAX_FILES_PER_SCAN = 5000 — very large repos truncate ast-grep pass
- Python/Go rules less mature than TS/JS

### 20.3 File-tree fallback accuracy

- Directory heuristics + regex — **no call graph**
- Useful when ctags binary missing or project empty
- `engine: file-tree` signals low structural confidence

### 20.4 Speed characteristics (order of magnitude)

| Operation | Typical | Notes |
|-----------|---------|-------|
| Cold `ensureSymbolIndex` | 2–30s | scales with file count |
| Cold `runStructuralScan` | 5–60s | worker pool + file cap |
| `get_blueprint` cache hit | <100ms | disk + ignore filter |
| Incremental file update | 50–500ms | 1 ctags + 1 ast-grep file |
| `search(text)` | 10–200ms | ripgrep bound |
| BM25 first build | 1–10s | in-memory index |
| BM25 subsequent | 10–50ms | |
| Structural BFS | 100ms–2s | includes lazy parse if cold |

Single-flight prevents duplicate cold-parse storms when model calls `get_blueprint` + `search(structural)` concurrently.

### 20.5 When BM25 beats grep

- Conceptual queries (“authentication middleware”, “payment idempotency”) with no literal token
- Warm symbol index with meaningful names/signatures in codebase
- Grep wins for exact error strings, env var names, UUIDs, log tags

---

## 21. Removed stack (v8.6)

| Removed | Replacement |
|---------|-------------|
| `oxc-parser` | Universal Ctags for symbols |
| tree-sitter WASM RTE parsers | ast-grep + lang packs for edges |
| Per-language RTE parsers (TS, Py, Go, Rust, …) | ctags kinds + ast-grep rules |
| Parser worker pool (oxc) | `astgrep_worker.js` pool |
| `bench-parsers.ts` | `bench-blueprint-index.ts` |
| Auto blueprint:structure` injection in prompts | Tool-driven `get_blueprint` only |

Deleted paths include `src/lib/blueprint/rte/parsers/{typescript,python,go,...}.ts` and WASM extraction utilities.

---

## 22. Appendix: key file index

| Concern | Path |
|---------|------|
| Lazy parse orchestration | `Atlarix/src/lib/blueprint/lazy-parse.ts` |
| Blueprint IPC + infer chain | `Atlarix/src/ipc/handlers/blueprint_handlers.ts` |
| `generateBlueprint` | `Atlarix/src/lib/blueprint/rte/parsers/index.ts` |
| Ctags index | `Atlarix/src/lib/index/ctags-index.ts` |
| Ctags JSON parse | `Atlarix/src/lib/index/ctags-parse.ts` |
| Symbol types | `Atlarix/src/lib/index/symbol-types.ts` |
| Structural scan orchestration | `Atlarix/src/lib/blueprint/rte/ast-grep/run-structural-scan.ts` |
| Per-file edge extraction | `Atlarix/src/lib/blueprint/rte/ast-grep/scan-file-edges.ts` |
| Import/call/route rules | `Atlarix/src/lib/blueprint/rte/ast-grep/rules/` |
| Lang map | `Atlarix/src/lib/blueprint/rte/ast-grep/lang-map.ts` |
| Python/Go registration | `Atlarix/src/lib/blueprint/rte/ast-grep/register-dynamic-langs.ts` |
| Worker pool | `Atlarix/src/lib/blueprint/rte/ast-grep/worker-pool.ts` |
| ast-grep worker entry | `Atlarix/workers/blueprint/astgrep_worker.ts` |
| Graph BFS | `Atlarix/src/lib/blueprint/rte/ast-grep/graph-bfs.ts` |
| RTE → Blueprint | `Atlarix/src/lib/blueprint/rte_to_blueprint.ts` |
| File-tree fallback | `Atlarix/src/lib/blueprint/rte/file-tree-bridge.ts` |
| Blueprint cache | `Atlarix/src/lib/cache/blueprint-cache.ts` |
| Cache types | `Atlarix/src/shared/blueprint-cache-types.ts` |
| Incremental merge | `Atlarix/src/lib/blueprint/incremental-update.ts` |
| File watcher | `Atlarix/src/lib/blueprint/blueprint-file-watcher.ts` |
| Markdown serialization | `Atlarix/src/lib/blueprint/blueprint-markdown.ts` |
| Section path validation | `Atlarix/src/lib/blueprint/section-path.ts` |
| Slice resolution | `Atlarix/src/lib/blueprint/blueprint-slice.ts` |
| Richness assessment | `Atlarix/src/lib/blueprint/blueprint-quality.ts` |
| Thin-graph merge | `Atlarix/src/lib/blueprint/blueprint-merge.ts` |
| Hybrid RTE supplement | `Atlarix/src/lib/blueprint/rte-supplement.ts` |
| Section-first agent skill | `Atlarix/src/skills/guides/blueprint-section-first.md` |
| `get_blueprint` tool | `Atlarix/src/lib/tools/blueprint.ts` |
| Unified search tool | `Atlarix/src/lib/tools/search.ts` |
| Search mode routing | `Atlarix/src/lib/search/search-mode-routing.ts` |
| BM25 index | `Atlarix/src/lib/search/bm25_semantic_index.ts` |
| Structural graph query | `Atlarix/src/lib/search/structural-graph-query.ts` |
| Blast radius | `Atlarix/src/lib/blueprint/blast-radius.ts` |
| Permission enrichment | `Atlarix/src/lib/tools/permissions/enrich-blast-radius.ts` |
| Project file discovery | `Atlarix/src/ipc/utils/project-files.ts` |
| Fetch ctags script | `Atlarix/scripts/fetch-ctags.mjs` |
| Architecture overview (shorter) | `Atlarix/docs/architecture.md` |
| Release notes | `Atlarix/docs/CHANGELOG.md` |

---

## Appendix B: Example tool sequences for the model

### B.1 Explore unfamiliar module

```
1. get_blueprint({ focus_path: "src/auth", scope: "full" })
2. search({ query: "session validation", mode: "auto" })
3. get_file_outline({ path: "src/auth/session.ts" })
4. read_file({ path: "src/auth/session.ts", start_line: 40, end_line: 90 })
```

### B.2 Trace callers

```
1. search({ query: "what calls verifyToken", mode: "structural" })
   → BFS reverse on call edges from symbol verifyToken
2. read_file on top hit files only
```

### B.3 Exact string hunt

```
1. search({ query: "ATLARIX_AGENT_AUTHOR", mode: "text", path: "src/" })
   → ripgrep with glob **/src/**
```

### B.4 Pre-edit impact (user-visible)

User approves `write_file` → permission card shows `estimatedImpact` from blast radius BFS (guided/build modes only).

---

## Appendix C: Cache file locations (in repo workspace)

```
<workspace>/
  .atlarix/
    symbols.json          # ctags symbol index
    .ctags-filelist         # transient during ctags run
    blueprint.json          # optional committed snapshot (Workforce)
    ATLARIX.md              # workspace memory (separate concern)
  .atlarixignore            # parse/search exclusions
```

Global blueprint cache also written under user data (`~/.atlarix/blueprints/`) keyed by project hash — see `blueprint-cache.ts` for path resolution.

---

*End of reference. For product-facing release notes see `atlarix-launchpad/public/CHANGELOG.md`; for maintainer changelog see `Atlarix/docs/CHANGELOG.md`.*
