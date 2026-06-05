/**
 * App Map - Language-agnostic spec for project → diagram (structure only)
 * Used by: project → AppMap → Mermaid diagram (diagram-first; no workflow nodes)
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

