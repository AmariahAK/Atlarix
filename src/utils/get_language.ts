/**
 * File path → syntax-highlight language id.
 *
 * Output is clamped to the language set registered in CodeHighlight's shiki
 * core (`src/components/chat/CodeHighlight.tsx`) — an id outside that set
 * would render unhighlighted anyway, and markdown fences accept any string,
 * so the shiki set is the useful vocabulary for both consumers.
 */

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  pyw: "python",
  pyi: "python",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  vue: "vue",
  astro: "astro",
  graphql: "graphql",
  gql: "graphql",
  java: "java",
};

export function getLanguage(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "text";
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? "text";
}
