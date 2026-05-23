/**
 * Symbol index types (Universal Ctags → internal model).
 */

export type SymbolRecord = {
  /** Stable hash(path + name + line + kind). */
  id: string;
  name: string;
  /** Ctags kind letter or long name (f, c, m, function, class, …). */
  kind: string;
  /** Workspace-relative file path. */
  path: string;
  line: number;
  endLine?: number;
  scope?: string;
  signature?: string;
};

export type SymbolIndexManifest = {
  projectPath: string;
  timestamp: number;
  fileCount: number;
  symbolCount: number;
  commitHash?: string | null;
  ctagsVersion?: string;
  engine: "ctags";
};

export type SymbolIndexCache = {
  manifest: SymbolIndexManifest;
  symbols: SymbolRecord[];
};
