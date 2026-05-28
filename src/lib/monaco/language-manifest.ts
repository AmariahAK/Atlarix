/**
 * Unified extension → Monaco language / TextMate grammar mapping for editors.
 */

export interface MonacoLanguageEntry {
  /** Monaco `languages.getLanguages()` id */
  monacoId: string;
  /** Grammar file basename under `grammars/` (defaults to monacoId) */
  grammarId?: string;
  /** File extensions without dot */
  extensions: string[];
  /** Basenames without extension (e.g. Dockerfile) */
  filenames?: string[];
}

export const MONACO_LANGUAGE_MANIFEST: MonacoLanguageEntry[] = [
  {
    monacoId: "typescript",
    extensions: ["ts", "tsx", "mts", "cts"],
  },
  {
    monacoId: "javascript",
    extensions: ["js", "jsx", "mjs", "cjs"],
  },
  {
    monacoId: "python",
    extensions: ["py", "pyw", "pyi"],
  },
  {
    monacoId: "rust",
    extensions: ["rs"],
  },
  {
    monacoId: "go",
    extensions: ["go"],
  },
  {
    monacoId: "vue",
    extensions: ["vue"],
  },
  {
    monacoId: "svelte",
    extensions: ["svelte"],
  },
  {
    monacoId: "yaml",
    extensions: ["yaml", "yml"],
  },
  {
    monacoId: "toml",
    extensions: ["toml"],
  },
  {
    monacoId: "dockerfile",
    grammarId: "docker",
    extensions: ["dockerfile"],
    filenames: ["Dockerfile", "Containerfile"],
  },
  {
    monacoId: "json",
    extensions: ["json", "jsonc"],
  },
  {
    monacoId: "markdown",
    extensions: ["md", "markdown", "mdx"],
  },
  {
    monacoId: "html",
    extensions: ["html", "htm"],
  },
  {
    monacoId: "css",
    extensions: ["css", "scss", "sass", "less"],
  },
  {
    monacoId: "java",
    extensions: ["java"],
  },
  {
    monacoId: "csharp",
    extensions: ["cs"],
  },
  {
    monacoId: "cpp",
    extensions: ["cpp", "cc", "cxx", "hpp", "h"],
  },
  {
    monacoId: "c",
    extensions: ["c"],
  },
  {
    monacoId: "ruby",
    extensions: ["rb"],
  },
  {
    monacoId: "php",
    extensions: ["php"],
  },
  {
    monacoId: "swift",
    extensions: ["swift"],
  },
  {
    monacoId: "kotlin",
    extensions: ["kt", "kts"],
  },
  {
    monacoId: "shell",
    extensions: ["sh", "bash", "zsh"],
  },
];

const extMap = new Map<string, MonacoLanguageEntry>();
const nameMap = new Map<string, MonacoLanguageEntry>();

for (const entry of MONACO_LANGUAGE_MANIFEST) {
  for (const ext of entry.extensions) {
    extMap.set(ext.toLowerCase(), entry);
  }
  for (const name of entry.filenames ?? []) {
    nameMap.set(name.toLowerCase(), entry);
  }
}

export function getManifestEntryForPath(filePath: string): MonacoLanguageEntry | undefined {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const byName = nameMap.get(base.toLowerCase());
  if (byName) return byName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return extMap.get(ext);
}

/** Monaco editor language id for a file path */
export function getMonacoLanguageForPath(filePath: string): string {
  return getManifestEntryForPath(filePath)?.monacoId ?? "plaintext";
}

/** TextMate grammar bundle id (filename without .json) */
export function getGrammarIdForPath(filePath: string): string | undefined {
  const entry = getManifestEntryForPath(filePath);
  if (!entry) return undefined;
  return entry.grammarId ?? entry.monacoId;
}

/** @deprecated Use getMonacoLanguageForPath — kept for existing imports */
export function getLanguage(filePath: string): string {
  return getMonacoLanguageForPath(filePath);
}
