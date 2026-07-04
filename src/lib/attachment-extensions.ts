/**
 * W3 (v14.8.11): ONE list of text-readable attachment extensions, shared by
 * the read_attachment extractor and the send-time inline preview — the
 * preview used to whitelist only 8 extensions, so a `.py`/`.go` upload got
 * NO preview at all while read_attachment could read it fine.
 */
export const SUPPORTED_TEXT_EXTENSIONS = [
  ".md", ".txt", ".json", ".csv", ".js", ".ts", ".tsx", ".jsx",
  ".html", ".css", ".py", ".yaml", ".yml", ".xml", ".sh", ".bash",
  ".zsh", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".cs",
  ".rb", ".php", ".sql", ".graphql", ".env", ".gitignore", ".eslintrc",
  ".prettierrc", ".mdx", ".rst", ".log", ".toml", ".ini", ".cfg",
];

export function isSupportedTextExtension(ext: string): boolean {
  return SUPPORTED_TEXT_EXTENSIONS.includes(ext.toLowerCase());
}
