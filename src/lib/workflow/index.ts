/**
 * Workflow module - Diagram-first (Deep Mermaid)
 * Code → Extract structure (AppMap) → Mermaid diagram.
 * No n8n-style workflow nodes; diagram is the single source of truth.
 */

export { extractAppMap, extractAppMapFromNode, extractAppMapFromPython, detectRuntime } from "./extractors";
export type { AppMap, AppMapEntryPoint, AppMapDataSource, AppMapFlow, AppMapScreen, Runtime } from "./app_map_types";
export { appMapToGraphSpec, appMapToGraphJson } from "./app_map_to_graph_spec";
