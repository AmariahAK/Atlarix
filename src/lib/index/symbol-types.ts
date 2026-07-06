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
  /** Language as reported by ctags (`--fields=+l`), lowercased (e.g. "typescript", "ruby"). */
  language?: string;
};

export type SymbolIndexManifest = {
  projectPath: string;
  timestamp: number;
  fileCount: number;
  symbolCount: number;
  commitHash?: string | null;
  ctagsVersion?: string;
  engine: "ctags";
  /**
   * v10.1: mtimeMs per indexed (ctags-eligible) file. On staleness, only
   * changed/added/deleted files are re-tagged instead of the whole repo.
   * Absent on pre-v10.1 caches — those rebuild fully once.
   */
  fileMtimes?: Record<string, number>;
};

export type SymbolIndexCache = {
  manifest: SymbolIndexManifest;
  symbols: SymbolRecord[];
};
