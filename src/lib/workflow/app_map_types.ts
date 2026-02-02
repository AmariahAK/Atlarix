/**
 * App Map - Language-agnostic spec for project ↔ Atlaflow ↔ diagram round-trip
 * Used by: project → Atlaflow, Atlaflow → project, modify Atlaflow → project + diagram
 */

export type Runtime =
  | "node"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "php"
  | "dotnet"
  | "elixir"
  | "deno"
  | "bun";

/** Backend: entry points (HTTP, RPC, CLI, job, queue) */
export interface AppMapEntryPoint {
  id: string;
  type: "http" | "rpc" | "cli" | "job" | "queue";
  method?: string;
  path?: string;
  name?: string;
  handlerFile?: string;
  handlerSymbol?: string;
  summary?: string;
  /** For Atlaflow round-trip: node id in workflow */
  nodeId?: string;
}

/** Backend + frontend: data sources (DB, cache, API, etc.) */
export interface AppMapDataSource {
  id: string;
  type: "database" | "cache" | "queue" | "api" | "file";
  name?: string;
  usage?: string[];
  nodeId?: string;
}

/** Optional flow: "A calls B", "A reads B" */
export interface AppMapFlow {
  from: string;
  to: string;
  kind: "calls" | "reads" | "writes";
}

/** Frontend: screens/pages (for full-stack app map) */
export interface AppMapScreen {
  id: string;
  path?: string;
  name?: string;
  file?: string;
  nodeId?: string;
}

/** Full app map: backend + optional frontend */
export interface AppMap {
  runtime: Runtime;
  entryPoints: AppMapEntryPoint[];
  dataSources: AppMapDataSource[];
  flows?: AppMapFlow[];
  screens?: AppMapScreen[];
  /** Optional: global prompt / instructions for codegen */
  globalPrompt?: string;
}
