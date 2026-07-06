/**
 * Blueprint cache and combined blueprint schema types
 * Used for persisting RTE-generated blueprints under ~/.atlarix/blueprints/
 */

import type { Blueprint } from "./blueprint-types";
import type { BlueprintNode, RTEBlueprintEdge } from "@/lib/blueprint/rte/parsers/types";

/** Manifest for a single-project blueprint cache */
export interface BlueprintManifest {
  projectId?: string;
  projectHash: string;
  projectPath: string;
  framework: string;
  language: string;
  detailLevel?: "overview" | "full";
  timestamp: number;
  /** Index engine used when cache was written. */
  engine?: "ast-grep+ctags" | "ctags-only" | "file-tree" | "hybrid";
  /** v12 S20: unresolved (non-identifier-callee) call sites from the scan. */
  dynamicCallCount?: number;
}

/** Full RTE graph stored in cache */
export interface BlueprintCacheContent {
  manifest: BlueprintManifest;
  nodes: BlueprintNode[];
  edges: RTEBlueprintEdge[];
  /** Legacy Blueprint shape for UI compatibility */
  blueprint?: Blueprint;
  /** Raw `.atlarixignore` used when this cache was written (skip disk read for ignore filtering). */
  atlarixIgnoreSource?: string;
}
