/**
 * LSP language ids the app can attach servers for.
 * Renderer-safe (no electron) — keep in sync with LSP_SERVERS in lsp-server-registry.ts.
 */

const LSP_SUPPORTED_LANGUAGE_IDS = [
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "python",
  "rust",
  "go",
  "java",
  "kotlin",
  "c",
  "cpp",
  "objective-c",
  "objective-cpp",
  "csharp",
  "ruby",
  "php",
  "swift",
  "lua",
  "bash",
  "shell",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  "json",
  "yaml",
  "toml",
  "graphql",
  "dockerfile",
  "vue",
  "svelte",
] as const;

export const LSP_SUPPORTED_LANGUAGES = new Set<string>(
  LSP_SUPPORTED_LANGUAGE_IDS,
);

export function isLspLanguageSupported(language: string): boolean {
  return LSP_SUPPORTED_LANGUAGES.has(language);
}
