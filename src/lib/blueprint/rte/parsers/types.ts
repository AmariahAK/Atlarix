/**
 * RTE (Round-Trip Engineering) parser types
 * Language-agnostic node and framework types compatible with Blueprint and AppMap.
 */

/** Node type for blueprint/RAG (aligns with step types and AppMap) */
export type BlueprintNodeType =
  | "api"
  | "webhook"
  | "function"
  | "feature"
  | "class"
  | "cron"
  | "ai"
  | "db"
  | "3p"
  | "stream"
  | "conditional";

export type DescriptionSource = "jsdoc" | "pattern" | "ai" | "ollama";

export interface BlueprintNode {
  id: string;
  type: BlueprintNodeType;
  name: string;
  /** Source file path (relative to project root) */
  file: string;
  /** Line number in file (1-based) */
  line?: number;
  /** Optional description or route path */
  description?: string;
  /** Human-readable one-liner from JSDoc, pattern, or AI */
  simpleDescription?: string;
  descriptionSource?: DescriptionSource;
  /** For API: HTTP method */
  method?: string;
  /** For API/Webhook: path or route */
  path?: string;
  /** IDs of nodes this node calls (for edges) */
  calls?: string[];
  /** IDs of nodes that call this node */
  calledBy?: string[];
  /** Room/cluster id this node belongs to (for grouping) */
  roomId?: string;
}

export interface RTEBlueprintEdge {
  from: string;
  to: string;
  label?: string;
  type?: "calls" | "imports" | "api_call";
}

export interface FrameworkInfo {
  name: string;
  version?: string;
  confidence: number;
}

export interface RTEParseResult {
  nodes: BlueprintNode[];
  edges: RTEBlueprintEdge[];
  framework: FrameworkInfo;
}

/**
 * Language parser interface for RTE.
 * Each language implements parse + detectFramework.
 */
export interface LanguageParser {
  parse(files: string[]): Promise<BlueprintNode[]>;
  detectFramework(files: string[]): Promise<FrameworkInfo>;
}

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "kotlin"
  | "elixir";
